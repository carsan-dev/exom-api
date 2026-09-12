import { Client } from 'pg';
import { databasePoolConfig } from './pool-config';

const base = {
  DATABASE_URL: 'postgresql://fixture:synthetic@localhost:5432/fixture',
  NODE_ENV: 'production',
};

describe('database pool configuration', () => {
  it('verifies TLS by default and bounds connection acquisition', () => {
    expect(databasePoolConfig(base)).toMatchObject({
      max: 10,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 10000,
      ssl: { rejectUnauthorized: true },
    });
  });
  it('supports explicit sizes, idle eviction disabled, and a custom CA', () => {
    expect(
      databasePoolConfig({
        ...base,
        DATABASE_POOL_MAX: '4',
        DATABASE_POOL_IDLE_TIMEOUT_MS: '0',
        DATABASE_POOL_CONNECTION_TIMEOUT_MS: '250',
        DATABASE_SSL_CA: 'fixture-ca',
      }),
    ).toMatchObject({
      max: 4,
      idleTimeoutMillis: 0,
      connectionTimeoutMillis: 250,
      ssl: { rejectUnauthorized: true, ca: 'fixture-ca' },
    });
  });
  it.each(['-1', 'NaN', '1.5', '', 'Infinity', '2147483648'])(
    'rejects invalid pool values without echoing them: %s',
    (value) => {
      expect(() =>
        databasePoolConfig({ ...base, DATABASE_POOL_MAX: value }),
      ).toThrow('DATABASE_POOL_MAX must');
    },
  );
  it('rejects unlimited acquisition and zero connections', () => {
    expect(() =>
      databasePoolConfig({ ...base, DATABASE_POOL_MAX: '0' }),
    ).toThrow();
    expect(() =>
      databasePoolConfig({ ...base, DATABASE_POOL_CONNECTION_TIMEOUT_MS: '0' }),
    ).toThrow();
  });
  it.each([
    'sslmode=no-verify',
    'sslmode=disable',
    'ssl=0',
    'ssl=no-verify',
    'sslrootcert=secret',
    'sslcert=secret',
    'sslkey=secret',
  ])(
    'rejects production TLS weakening or hidden URL overrides: %s',
    (option) => {
      expect(() =>
        databasePoolConfig({
          ...base,
          DATABASE_URL: `${base.DATABASE_URL}?${option}`,
        }),
      ).toThrow();
    },
  );
  it('keeps require verified under the installed pg parser, preserving other parameters', () => {
    const config = databasePoolConfig({
      ...base,
      DATABASE_URL: `${base.DATABASE_URL}?sslmode=require&application_name=phase8&uselibpqcompat=true`,
    });
    const client = new Client(config);
    expect(client.ssl).toMatchObject({ rejectUnauthorized: true });
    expect(client.ssl).toHaveProperty(
      'checkServerIdentity',
      expect.any(Function),
    );
    expect(config.connectionString).toContain('application_name=phase8');
  });
  it('allows explicit local plaintext and rejects the global production bypass', () => {
    expect(
      databasePoolConfig({
        ...base,
        NODE_ENV: 'test',
        DATABASE_SSL_MODE: 'disable',
      }).ssl,
    ).toBe(false);
    expect(() =>
      databasePoolConfig({ ...base, NODE_TLS_REJECT_UNAUTHORIZED: '0' }),
    ).toThrow('Production requires');
  });
  it('does not expose invalid URLs or their credentials', () => {
    expect(() =>
      databasePoolConfig({ DATABASE_URL: 'bad secret-password' }),
    ).toThrow('DATABASE_URL must be a PostgreSQL URL');
  });
});
