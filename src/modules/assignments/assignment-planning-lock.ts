import { Prisma } from '@prisma/client';
import { NotFoundException } from '@nestjs/common';
import type { AssignmentTransaction } from './last-set-video-policy.service';
import { lockClientDayProgress } from '../../common/progress/day-progress-lock';

export const ASSIGNMENT_TRANSACTION_OPTIONS = {
  maxWait: 5_000,
  timeout: 30_000,
} as const;

export async function lockAssignmentPlanning(
  db: AssignmentTransaction,
  clientId: string,
): Promise<void> {
  // Shared order: progress advisory lock, then user row, then assignment/link
  // rows. Progress creation needs a user FK lock; reversing these can deadlock.
  await lockClientDayProgress(db, clientId);
  const users = await db.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT "id" FROM "users" WHERE "id" = ${clientId} FOR UPDATE`,
  );
  if (users.length === 0) {
    throw new NotFoundException('Cliente no encontrado');
  }
}
