import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createServer, Server, Socket } from 'node:net';
import { createSecureContext, TLSSocket } from 'node:tls';
import { Pool } from 'pg';
import { databasePoolConfig } from './pool-config';
import { PrismaService } from './prisma.service';

describe('verified PostgreSQL TLS and connection failures', () => {
  let directory: string;
  let certificate: string;
  let server: Server;
  let port: number;
  const sockets = new Set<Socket>();
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'exom-p8-tls-'));
    const openssl =
      process.env.OPENSSL_BIN ??
      (existsSync('C:/Program Files/Git/usr/bin/openssl.exe')
        ? 'C:/Program Files/Git/usr/bin/openssl.exe'
        : 'openssl');
    execFileSync(
      openssl,
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        join(directory, 'key.pem'),
        '-out',
        join(directory, 'cert.pem'),
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost',
      ],
      { windowsHide: true, stdio: 'ignore' },
    );
    certificate = readFileSync(join(directory, 'cert.pem'), 'utf8');
    const context = createSecureContext({
      cert: certificate,
      key: readFileSync(join(directory, 'key.pem')),
    });
    server = createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => undefined);
      socket.once('data', () => {
        socket.write('S'); // PostgreSQL SSLRequest acceptance, then a real TLS handshake.
        const secure = new TLSSocket(socket, {
          isServer: true,
          secureContext: context,
        });
        secure.on('error', () => undefined);
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing local test socket');
    port = address.port;
  });
  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    if (server) await new Promise<void>((done) => server.close(() => done()));
    const target = resolve(directory);
    if (!target.startsWith(resolve(tmpdir()) + sep + 'exom-p8-tls-'))
      throw new Error('Unsafe test cleanup path');
    rmSync(target, { recursive: true });
  });
  it.each([false, true])(
    'rejects untrusted certificates and trusted certificates with the wrong hostname (custom CA: %s)',
    async (trusted) => {
      const pool = new Pool(
        databasePoolConfig({
          DATABASE_URL: `postgresql://fixture:synthetic-secret@127.0.0.1:${port}/fixture`,
          NODE_ENV: 'production',
          DATABASE_POOL_CONNECTION_TIMEOUT_MS: '500',
          ...(trusted ? { DATABASE_SSL_CA: certificate } : {}),
        }),
      );
      try {
        await expect(pool.query('SELECT 1')).rejects.toMatchObject({
          code: trusted
            ? 'ERR_TLS_CERT_ALTNAME_INVALID'
            : 'DEPTH_ZERO_SELF_SIGNED_CERT',
        });
      } finally {
        await pool.end();
      }
    },
  );
  it('fails service startup without logging or throwing credentials and closes its pool', async () => {
    const previous = { ...process.env };
    try {
      process.env.DATABASE_URL = `postgresql://fixture:synthetic-secret@127.0.0.1:${port}/fixture`;
      process.env.NODE_ENV = 'production';
      process.env.DATABASE_POOL_CONNECTION_TIMEOUT_MS = '500';
      delete process.env.DATABASE_SSL_MODE;
      delete process.env.DATABASE_SSL_CA;
      const service = new PrismaService();
      await expect(service.onModuleInit()).rejects.toThrow(
        'Database connection failed; verify connectivity and TLS configuration',
      );
      expect(service.postgresqlPool.ended).toBe(true);
      await service.onModuleDestroy();
    } finally {
      process.env = previous;
    }
  });
});
