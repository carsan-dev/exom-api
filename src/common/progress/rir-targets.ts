import { Prisma } from '@prisma/client';

export async function loadRirTargets(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  client: string,
  date: Date,
) {
  const rows = await db.$queryRaw<
    Array<{ training_exercise_id: string; target_rir: number | null }>
  >(
    Prisma.sql`SELECT training_exercise_id,target_rir FROM rir_day_targets WHERE client_id = ${client} AND date = ${date}::date`,
  );
  return new Map(rows.map((r) => [r.training_exercise_id, r.target_rir]));
}

export function applyRirTargets<
  T extends {
    exercises: Array<{ id: string; target_rir?: number | null }>;
    blocks?: Array<{
      exercises: Array<{ id: string; target_rir?: number | null }>;
    }>;
  },
>(training: T, targets: Map<string, number | null>): T {
  const apply = <E extends { id: string; target_rir?: number | null }>(
    e: E,
  ): E => (targets.has(e.id) ? { ...e, target_rir: targets.get(e.id)! } : e);
  return {
    ...training,
    exercises: training.exercises.map(apply),
    ...(training.blocks
      ? {
          blocks: training.blocks.map((b) => ({
            ...b,
            exercises: b.exercises.map(apply),
          })),
        }
      : {}),
  };
}
