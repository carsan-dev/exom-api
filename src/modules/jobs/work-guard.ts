import { Pool, PoolClient } from 'pg';

// Only advisory locks live in this transaction. Business writes and claims commit
// separately. Prisma's interactive timeout must not release a live handler's locks.
export async function withWorkGuard<T>(
  pool: Pool,
  run: (connection: PoolClient) => Promise<T>,
): Promise<T> {
  const connection = await pool.connect();
  let connectionError: Error | undefined;
  const onError = (error: Error) => {
    connectionError = error;
  };
  connection.on('error', onError);
  try {
    await connection.query('BEGIN');
    await connection.query(
      "SET LOCAL idle_in_transaction_session_timeout = '0'",
    );
    return await run(connection);
  } finally {
    try {
      await connection.query('ROLLBACK');
    } catch (error) {
      connectionError =
        error instanceof Error ? error : new Error('GUARD_CONNECTION_LOST');
    }
    connection.removeListener('error', onError);
    connection.release(connectionError);
  }
}
