import { Prisma } from '@prisma/client';
import { PaginationDto } from './dto/pagination.dto';

export function searchPredicate(expression: Prisma.Sql, search?: string) {
  const term = search?.trim();
  // strpos preserves literal %, _, backslashes and cross-field matches.
  return term
    ? Prisma.sql`strpos(public.exom_normalize_search(${expression}), public.exom_normalize_search(${term})) > 0`
    : Prisma.sql`TRUE`;
}

export function allOf(predicates: Prisma.Sql[]) {
  return Prisma.join(
    predicates.map((predicate) => Prisma.sql`(${predicate})`),
    ' AND ',
  );
}

export function inList(column: Prisma.Sql, values?: readonly string[]) {
  return values?.length
    ? Prisma.sql`${column}::text IN (${Prisma.join(values)})`
    : Prisma.sql`TRUE`;
}

export function dateRange(column: Prisma.Sql, from?: string, to?: string) {
  return allOf([
    from
      ? Prisma.sql`${column} >= ${new Date(`${from}T00:00:00.000Z`)}`
      : Prisma.sql`TRUE`,
    to
      ? Prisma.sql`${column} <= ${new Date(`${to}T23:59:59.999Z`)}`
      : Prisma.sql`TRUE`,
  ]);
}

/** Only IDs for one page cross the DB boundary, including on empty later pages.
 * Call hydration inside the same RepeatableRead transaction as this statement.
 */
export async function queryPage(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  from: Prisma.Sql,
  where: Prisma.Sql,
  order: Prisma.Sql,
  pagination: PaginationDto,
) {
  const [result] = await tx.$queryRaw<
    Array<{ ids: string[]; total: bigint }>
  >(Prisma.sql`
    SELECT ARRAY(SELECT q.id FROM ${from} WHERE ${where}
      ORDER BY ${order} OFFSET ${pagination.skip} LIMIT ${pagination.limit ?? 20}) AS ids,
      (SELECT count(*) FROM ${from} WHERE ${where}) AS total`);
  return { ids: result.ids, total: Number(result.total) };
}

/** Hydration can return rows in any order. This only walks the bounded SQL page. */
export function inPageOrder<T extends { id: string }>(
  ids: string[],
  rows: T[],
): T[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => {
    const row = byId.get(id);
    if (!row) throw new Error('Database page changed during hydration');
    return row;
  });
}
