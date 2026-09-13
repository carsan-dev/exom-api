import { startupError, StartupError } from './startup-error';

describe('safe startup diagnostics', () => {
  const secret =
    'postgresql://fixture:synthetic-secret@private-host/db?token=secret';
  it.each([
    'SELF_SIGNED_CERT_IN_CHAIN',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'CERT_HAS_EXPIRED',
    'ECONNREFUSED',
    'ENOTFOUND',
    'ETIMEDOUT',
    '28P01',
    '53300',
    'EADDRINUSE',
  ])('reports allowlisted code %s without provider details', (code) => {
    const error = startupError('database', {
      code,
      message: secret,
      stack: secret,
    });
    expect(error.message).toContain(`[database/${code}]`);
    expect(error.message).not.toContain(secret);
    expect(error).not.toHaveProperty('cause');
  });
  it('recognizes the Prisma-wrapped Supavisor error without exposing its message', () => {
    const error = startupError('database', {
      code: 'P2010',
      message: secret,
      meta: {
        driverAdapterError: {
          cause: {
            originalCode: 'XX000',
            originalMessage: `(EMAXCONNSESSION) ${secret}`,
          },
        },
      },
    });
    expect(error.message).toContain('[database/EMAXCONNSESSION]');
    expect(error.message).toContain('DATABASE_POOL_MAX');
    expect(error.message).not.toContain(secret);
  });
  it('finds a network error in an AggregateError', () => {
    expect(
      startupError(
        'database',
        new AggregateError([
          Object.assign(new Error(secret), { code: 'ECONNREFUSED' }),
        ]),
      ).message,
    ).toContain('ECONNREFUSED');
  });
  it('bounds cyclic errors and hides arbitrary codes and messages', () => {
    const error = { code: secret, message: secret, cause: {} };
    error.cause = error;
    expect(startupError('firebase', error).message).toBe(
      'API startup failed [firebase/UNKNOWN]. Underlying details omitted to protect credentials.',
    );
  });
  it('preserves database context when propagated through bootstrap', () => {
    const error = new StartupError('database', { code: '28P01' });
    expect(startupError('listen', error)).toBe(error);
  });
  it('gives configuration guidance without exposing invalid values', () => {
    const error = startupError('database-configuration', new Error(secret));
    expect(error.message).toContain('DATABASE_URL');
    expect(error.message).toContain('production requires verified TLS');
    expect(error.message).not.toContain(secret);
  });
});
