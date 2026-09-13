const hints = {
  SELF_SIGNED_CERT_IN_CHAIN: 'Check DATABASE_SSL_CA (trusted CA PEM).',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'Check DATABASE_SSL_CA (trusted CA PEM).',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE:
    'Check DATABASE_SSL_CA and certificate chain.',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY:
    'Check DATABASE_SSL_CA and certificate chain.',
  CERT_HAS_EXPIRED: 'Check database certificate validity.',
  ERR_TLS_CERT_ALTNAME_INVALID:
    'Check DATABASE_URL hostname against certificate.',
  ECONNREFUSED: 'Check database host, port and availability.',
  ENOTFOUND: 'Check database hostname and DNS.',
  EAI_AGAIN: 'Check DNS availability.',
  ETIMEDOUT: 'Check network access and database availability.',
  ECONNRESET: 'Check network and database connection stability.',
  CONNECTION_TIMEOUT: 'Check network, database availability and pool capacity.',
  '28P01': 'Check database credentials in DATABASE_URL.',
  '28000': 'Check database authentication and access policy.',
  '3D000': 'Check database name in DATABASE_URL.',
  '53300': 'Check database connection capacity and DATABASE_POOL_MAX.',
  EMAXCONNSESSION:
    'Check session pool capacity, DATABASE_POOL_MAX and instance count.',
  EADDRINUSE: 'Check PORT; the listening address is already in use.',
  EACCES: 'Check network or listening-port permissions.',
  UNKNOWN: 'Underlying details omitted to protect credentials.',
} as const;

type DiagnosticCode = keyof typeof hints;
export type StartupStage =
  | 'firebase'
  | 'dependencies'
  | 'configuration'
  | 'database-configuration'
  | 'database'
  | 'listen';

function diagnosticCode(error: unknown): DiagnosticCode {
  // Prisma/pg wrap errors differently. Traverse only known links, with bounds
  // and cycle detection; never serialize messages, stacks, URLs or credentials.
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  for (let count = 0; pending.length && count < 24; count++) {
    const current = pending.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    for (const key of ['code', 'originalCode']) {
      const value: unknown = Reflect.get(current, key);
      if (typeof value === 'string' && Object.hasOwn(hints, value))
        return value as DiagnosticCode;
    }
    // Supavisor supplies this marker in the message, with generic SQLSTATE XX000.
    for (const key of ['message', 'originalMessage']) {
      const value: unknown = Reflect.get(current, key);
      if (typeof value !== 'string') continue;
      if (value.startsWith('(EMAXCONNSESSION)')) return 'EMAXCONNSESSION';
      if (
        value === 'Connection terminated due to connection timeout' ||
        value === 'timeout exceeded when trying to connect'
      )
        return 'CONNECTION_TIMEOUT';
    }
    for (const key of ['cause', 'meta', 'driverAdapterError'])
      pending.push(Reflect.get(current, key));
    const errors: unknown = Reflect.get(current, 'errors');
    if (Array.isArray(errors)) {
      const nested: unknown[] = errors;
      pending.push(...nested.slice(0, 8));
    }
  }
  return 'UNKNOWN';
}

export class StartupError extends Error {
  constructor(stage: StartupStage, error: unknown) {
    const code = diagnosticCode(error);
    const configurationHint =
      stage === 'database-configuration'
        ? ' Check DATABASE_URL, DATABASE_SSL_MODE, DATABASE_SSL_CA and DATABASE_POOL_*; production requires verified TLS.'
        : '';
    super(
      `API startup failed [${stage}/${code}]. ${hints[code]}${configurationHint}`,
    );
    this.name = 'StartupError';
  }
}

export function startupError(
  stage: StartupStage,
  error: unknown,
): StartupError {
  return error instanceof StartupError ? error : new StartupError(stage, error);
}
