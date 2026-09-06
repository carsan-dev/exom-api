import { Prisma } from '@prisma/client';

type JsonEncoded<T> = T extends Date
  ? string
  : T extends readonly (infer Item)[]
    ? JsonEncoded<Item>[]
    : T extends object
      ? { [Key in keyof T]: JsonEncoded<T[Key]> }
      : T;

// SQL v1 uses the same include contract as DietsService. Dates inside JSON are
// serialized strings, never falsely typed as Prisma Date objects.
export type HistoricalDiet = JsonEncoded<
  Prisma.DietGetPayload<{
    include: {
      group: { select: { id: true; name: true } };
      meals: {
        include: {
          ingredients: { include: { ingredient: true } };
          variants: {
            include: { ingredients: { include: { ingredient: true } } };
          };
        };
      };
    };
  }>
>;

export interface DietHistoryEntry {
  client_id: string;
  date: Date;
  diet_id: string;
  version: number;
  provenance: 'observed' | 'legacy_available';
  captured_at: Date;
  diet: HistoricalDiet;
}

export async function loadDietHistory(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  clientIds: string[],
  start: Date,
  end: Date = start,
): Promise<DietHistoryEntry[]> {
  if (!clientIds.length) return [];
  // Typed SQL boundary: payload is produced only by migration v1's capture
  // function; the version check and immutable trigger protect that contract.
  return db.$queryRaw<DietHistoryEntry[]>(Prisma.sql`
    SELECT client_id, date, diet_id, version, provenance, captured_at, diet
    FROM diet_day_snapshots
    WHERE client_id IN (${Prisma.join([...new Set(clientIds)])})
      AND date >= ${start}::date AND date <= ${end}::date
    ORDER BY date, captured_at, diet_id
  `);
}

export function dietHistoryKey(clientId: string, date: Date, dietId: string) {
  return `${clientId}:${date.toISOString().slice(0, 10)}:${dietId}`;
}

export function indexDietHistory(history: DietHistoryEntry[]) {
  return new Map(
    history.map((entry) => [
      dietHistoryKey(entry.client_id, entry.date, entry.diet_id),
      entry.diet,
    ]),
  );
}

export function historicalDietFor(
  index: Map<string, HistoricalDiet>,
  assignment: { client_id: string; date: Date; diet_id?: string | null },
) {
  return assignment.diet_id
    ? index.get(
        dietHistoryKey(
          assignment.client_id,
          assignment.date,
          assignment.diet_id,
        ),
      )
    : undefined;
}

export function flattenHistoricalMeals(diet: HistoricalDiet) {
  return diet.meals.flatMap((meal) => [meal, ...meal.variants]);
}
