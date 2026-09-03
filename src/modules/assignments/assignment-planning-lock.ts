import { Prisma } from '@prisma/client';
import type { AssignmentTransaction } from './last-set-video-policy.service';

export async function lockAssignmentPlanning(
  db: AssignmentTransaction,
  clientId: string,
): Promise<void> {
  await db.$queryRaw(
    Prisma.sql`SELECT "id" FROM "users" WHERE "id" = ${clientId} FOR UPDATE`,
  );
}
