import { Prisma } from '@prisma/client';
import type { DietsQueryDto } from '../modules/diets/dto/diets-query.dto';
import type { TrainingsQueryDto } from '../modules/trainings/dto/trainings-query.dto';
import type { IngredientsQueryDto } from '../modules/ingredients/dto/ingredients-query.dto';
import type { ExercisesQueryDto } from '../modules/exercises/dto/exercises-query.dto';
import {
  allOf,
  dateRange,
  inList,
  queryPage,
  searchPredicate,
} from './query-page';

function overlaps(column: Prisma.Sql, values?: string[]) {
  return values?.length
    ? Prisma.sql`${column} && ARRAY[${Prisma.join(values)}]::text[]`
    : Prisma.sql`TRUE`;
}
function range(column: Prisma.Sql, min?: number, max?: number) {
  return allOf([
    min != null ? Prisma.sql`${column} >= ${min}` : Prisma.sql`TRUE`,
    max != null ? Prisma.sql`${column} <= ${max}` : Prisma.sql`TRUE`,
  ]);
}
function group(query: { group_id?: string; ungrouped?: boolean }) {
  return query.group_id
    ? Prisma.sql`q.group_id = ${query.group_id}`
    : query.ungrouped
      ? Prisma.sql`q.group_id IS NULL`
      : Prisma.sql`TRUE`;
}
function order(field: string, direction: 'asc' | 'desc') {
  const allowed = [
    'name',
    'icon',
    'level',
    'estimated_duration_min',
    'estimated_calories',
    'updated_at',
    'created_at',
    'calories_per_100g',
    'protein_per_100g',
    'carbs_per_100g',
    'fat_per_100g',
    'training_usage_count',
    'video',
  ];
  if (!allowed.includes(field) || !['asc', 'desc'].includes(direction))
    throw new Error('Unsupported catalog ordering');
  const column =
    field === 'video'
      ? Prisma.sql`(q.video_url IS NOT NULL AND q.video_url <> '')`
      : Prisma.raw(`q."${field}"`);
  const dir = Prisma.raw(direction);
  return Prisma.sql`${column} ${dir}, q.id ${dir}`;
}

export function dietPage(
  tx: Prisma.TransactionClient,
  query: DietsQueryDto,
  field: string,
  direction: 'asc' | 'desc',
) {
  return queryPage(
    tx,
    Prisma.sql`diets q`,
    allOf([
      Prisma.sql`q.is_active`,
      group(query),
      searchPredicate(Prisma.sql`q.name`, query.search),
      overlaps(Prisma.sql`q.tags`, query.tags),
      dateRange(Prisma.sql`q.updated_at`, query.updated_from, query.updated_to),
      query.meal_types?.length || query.nutritional_badges?.length
        ? Prisma.sql`EXISTS (SELECT 1 FROM meals m WHERE m.diet_id = q.id AND ${allOf(
            [
              inList(Prisma.sql`m.type`, query.meal_types),
              overlaps(
                Prisma.sql`m.nutritional_badges`,
                query.nutritional_badges,
              ),
            ],
          )})`
        : Prisma.sql`TRUE`,
    ]),
    order(field, direction),
    query,
  );
}

export function trainingPage(
  tx: Prisma.TransactionClient,
  query: TrainingsQueryDto,
  types: string[],
  field: string,
  direction: 'asc' | 'desc',
) {
  return queryPage(
    tx,
    Prisma.sql`trainings q`,
    allOf([
      Prisma.sql`q.is_active`,
      group(query),
      searchPredicate(Prisma.sql`q.name`, query.search),
      overlaps(Prisma.sql`q.tags`, query.tags),
      inList(Prisma.sql`q.level`, query.level),
      range(
        Prisma.sql`q.estimated_duration_min`,
        query.duration_min,
        query.duration_max,
      ),
      types.length
        ? Prisma.sql`(${overlaps(Prisma.sql`q.types`, types)} OR ${inList(Prisma.sql`q.type`, types)})`
        : Prisma.sql`TRUE`,
    ]),
    order(field, direction),
    query,
  );
}

export function ingredientPage(
  tx: Prisma.TransactionClient,
  query: IngredientsQueryDto,
  field: string,
  direction: 'asc' | 'desc',
) {
  return queryPage(
    tx,
    Prisma.sql`ingredients q`,
    allOf([
      Prisma.sql`q.is_active`,
      searchPredicate(Prisma.sql`q.name`, query.search),
      dateRange(Prisma.sql`q.updated_at`, query.updated_from, query.updated_to),
      // Preserve the existing WITH_ICON contract (empty string is not null).
      query.has_icon?.length === 1
        ? query.has_icon[0] === 'WITH_ICON'
          ? Prisma.sql`q.icon IS NOT NULL`
          : Prisma.sql`(q.icon IS NULL OR q.icon = '')`
        : Prisma.sql`TRUE`,
      range(
        Prisma.sql`q.calories_per_100g`,
        query.calories_per_100g_min,
        query.calories_per_100g_max,
      ),
      range(
        Prisma.sql`q.protein_per_100g`,
        query.protein_per_100g_min,
        query.protein_per_100g_max,
      ),
      range(
        Prisma.sql`q.carbs_per_100g`,
        query.carbs_per_100g_min,
        query.carbs_per_100g_max,
      ),
      range(
        Prisma.sql`q.fat_per_100g`,
        query.fat_per_100g_min,
        query.fat_per_100g_max,
      ),
    ]),
    order(field, direction),
    query,
  );
}

export function exercisePage(
  tx: Prisma.TransactionClient,
  query: ExercisesQueryDto,
  field: string,
  direction: 'asc' | 'desc',
) {
  return queryPage(
    tx,
    Prisma.sql`(SELECT e.*, (SELECT count(DISTINCT te.training_id)::integer
    FROM training_exercises te JOIN trainings t ON t.id = te.training_id
    WHERE te.exercise_id = e.id AND t.is_active) AS training_usage_count FROM exercises e) q`,
    allOf([
      Prisma.sql`q.is_active`,
      searchPredicate(Prisma.sql`q.name`, query.search),
      overlaps(Prisma.sql`q.muscle_groups`, query.muscle_groups),
      overlaps(Prisma.sql`q.equipment`, query.equipment),
      inList(Prisma.sql`q.level`, query.level),
      query.training_usage === 'used'
        ? Prisma.sql`q.training_usage_count > 0`
        : query.training_usage === 'unused'
          ? Prisma.sql`q.training_usage_count = 0`
          : Prisma.sql`TRUE`,
    ]),
    order(field, direction),
    query,
  );
}
