import type { PoolConfig } from 'pg';
import { checkServerIdentity } from 'node:tls';

function integer(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  min: number,
) {
  const value = env[key];
  if (value === undefined) return fallback;
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < min ||
    Number(value) > 2147483647
  ) {
    throw new Error(`${key} must be an integer >= ${min} and <= 2147483647`);
  }
  return Number(value);
}

export function databasePoolConfig(
  env: NodeJS.ProcessEnv = process.env,
): PoolConfig {
  let url: URL;
  try {
    url = new URL(env.DATABASE_URL ?? '');
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname)
      throw new Error();
  } catch {
    throw new Error('DATABASE_URL must be a PostgreSQL URL');
  }
  // pg parses URL options after PoolConfig and would overwrite TLS settings.
  // Keep one explicit policy, including when libpq compatibility is requested.
  const mode =
    env.DATABASE_SSL_MODE ?? url.searchParams.get('sslmode') ?? 'verify-full';
  if (!['verify-full', 'require', 'disable'].includes(mode)) {
    throw new Error(
      'DATABASE_SSL_MODE/sslmode must be verify-full, require or disable',
    );
  }
  if (mode === 'disable' && env.NODE_ENV === 'production') {
    throw new Error('Production database connections require verified TLS');
  }
  for (const key of ['ssl', 'sslcert', 'sslkey', 'sslrootcert']) {
    if (url.searchParams.has(key))
      throw new Error(
        'Configure database TLS using DATABASE_SSL_MODE and DATABASE_SSL_CA',
      );
  }
  url.searchParams.delete('sslmode');
  url.searchParams.delete('uselibpqcompat');
  // Avoid URL overrides of the validated pool settings.
  for (const key of ['max', 'idleTimeoutMillis', 'connectionTimeoutMillis'])
    url.searchParams.delete(key);
  if (
    env.NODE_ENV === 'production' &&
    env.NODE_TLS_REJECT_UNAUTHORIZED === '0'
  ) {
    throw new Error('Production requires NODE_TLS_REJECT_UNAUTHORIZED enabled');
  }
  return {
    connectionString: url.toString(),
    max: integer(env, 'DATABASE_POOL_MAX', 10, 1),
    idleTimeoutMillis: integer(env, 'DATABASE_POOL_IDLE_TIMEOUT_MS', 10000, 0),
    connectionTimeoutMillis: integer(
      env,
      'DATABASE_POOL_CONNECTION_TIMEOUT_MS',
      10000,
      1,
    ),
    ssl:
      mode === 'disable'
        ? false
        : {
            rejectUnauthorized: true,
            // pg omits SNI for IP hosts; Node otherwise checks its localhost default.
            checkServerIdentity: (_hostname, certificate) =>
              checkServerIdentity(
                url.searchParams.get('host') ??
                  url.hostname.replace(/^\[|\]$/g, ''),
                certificate,
              ),
            ...(env.DATABASE_SSL_CA ? { ca: env.DATABASE_SSL_CA } : {}),
          },
  };
}
