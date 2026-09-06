import { Prisma } from '@prisma/client';

const LOCK_NAMESPACE = 'exom:day-progress';

export const DAY_PROGRESS_TRANSACTION_OPTIONS = {
  maxWait: 5_000,
  timeout: 30_000,
} as const;

export async function lockClientDayProgress(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  clientId: string,
): Promise<void> {
  // Catalog writers take this barrier exclusively BEFORE their row locks.
  // Keep it ahead of the client lock to avoid catalog -> client / client -> catalog.
  await tx.$queryRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock_shared(hashtextextended('exom:diet-history', 0))::text AS "locked"`,
  );
  await tx.$queryRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${LOCK_NAMESPACE}:${clientId}`}, 0))::text AS "locked"`,
  );
}

export async function lockClientsDayProgress(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  clientIds: Iterable<string>,
): Promise<void> {
  const sortedClientIds = [...new Set(clientIds)].sort();
  for (const clientId of sortedClientIds) {
    await lockClientDayProgress(tx, clientId);
  }
}
