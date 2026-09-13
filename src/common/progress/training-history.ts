import { Prisma } from '@prisma/client';

type JsonEncoded<T> = T extends Date
  ? string
  : T extends readonly (infer E)[]
    ? JsonEncoded<E>[]
    : T extends object
      ? { [K in keyof T]: JsonEncoded<T[K]> }
      : T;

export type HistoricalTraining = JsonEncoded<
  Prisma.TrainingGetPayload<{
    include: {
      exercises: { include: { exercise: true; block: true } };
      blocks: { include: { exercises: { include: { exercise: true } } } };
    };
  }>
>;

export async function loadTrainingHistory(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  client: string,
  date: Date,
): Promise<Map<string, HistoricalTraining>> {
  // SQL boundary mirrors migration v1 capture; timestamps in JSON remain strings.
  // Owner/date predicates plus immutable snapshots prevent cross-account adoption.
  const rows = await db.$queryRaw<
    Array<{ training_id: string; payload: HistoricalTraining }>
  >(Prisma.sql`
    SELECT training_id,payload FROM training_day_snapshots
    WHERE client_id=${client} AND date=${date}::date AND version=1
  `);
  return new Map(rows.map((row) => [row.training_id, row.payload]));
}
