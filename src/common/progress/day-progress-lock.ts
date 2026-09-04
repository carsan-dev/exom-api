import { Prisma } from '@prisma/client';

const LOCK_NAMESPACE = 'exom:day-progress';

export const DAY_PROGRESS_TRANSACTION_OPTIONS = {
  maxWait: 5_000,
  timeout: 30_000,
} as const;

export async function lockClientDayProgress(
  tx: Prisma.TransactionClient,
  clientId: string,
): Promise<void> {
  await tx.$queryRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${LOCK_NAMESPACE}:${clientId}`}, 0))::text AS "locked"`,
  );
}

export async function lockClientsDayProgress(
  tx: Prisma.TransactionClient,
  clientIds: Iterable<string>,
): Promise<void> {
  const sortedClientIds = [...new Set(clientIds)].sort();
  for (const clientId of sortedClientIds) {
    await lockClientDayProgress(tx, clientId);
  }
}
