import type {
  DietHistoryEntry,
  HistoricalDiet,
} from '../../common/progress/diet-history';

export const BODY_METRICS = [
  ['weight_kg', 'Peso', 'kg'],
  ['muscle_mass_kg', 'Masa muscular', 'kg'],
  ['height_cm', 'Altura', 'cm'],
  ['sleep_hours', 'Sueño', 'h'],
  ['neck_cm', 'Cuello', 'cm'],
  ['shoulders_cm', 'Hombros', 'cm'],
  ['chest_cm', 'Pecho', 'cm'],
  ['arm_left_cm', 'Brazo izquierdo', 'cm'],
  ['arm_right_cm', 'Brazo derecho', 'cm'],
  ['forearm_left_cm', 'Antebrazo izquierdo', 'cm'],
  ['forearm_right_cm', 'Antebrazo derecho', 'cm'],
  ['waist_cm', 'Cintura', 'cm'],
  ['hips_cm', 'Cadera', 'cm'],
  ['thigh_left_cm', 'Muslo izquierdo', 'cm'],
  ['thigh_right_cm', 'Muslo derecho', 'cm'],
  ['calf_left_cm', 'Gemelo izquierdo', 'cm'],
  ['calf_right_cm', 'Gemelo derecho', 'cm'],
] as const;
export const HABIT_METRICS = [
  ['average_daily_steps', 'Pasos · media diaria semanal', 'pasos/día'],
  ['stress_level', 'Estrés semanal', '0–5'],
  ['hunger_level', 'Hambre semanal', '1–10'],
  ['energy_level', 'Energía semanal', '1–10'],
  ['digestion_level', 'Digestión semanal', '1–10'],
] as const;
export const NUTRIENT_METRICS = [
  ['calories', 'Calorías estimadas', 'kcal'],
  ['protein_g', 'Proteína estimada', 'g'],
  ['carbs_g', 'Carbohidratos estimados', 'g'],
  ['fat_g', 'Grasas estimadas', 'g'],
] as const;

export interface MetricObservation {
  date: string;
  value: number | null;
  end_date?: string;
  quality: 'complete' | 'partial' | 'missing';
  provenance: string;
}

export interface MetricSeries {
  key: string;
  label: string;
  unit: string;
  group: 'body' | 'habits' | 'nutrition';
  source: string;
  first: MetricObservation | null;
  last: MetricObservation | null;
  change: number | null;
  count: number;
  incomplete_count: number;
  points: MetricObservation[];
}

export function createMetricSeries(): MetricSeries[] {
  return [
    ...BODY_METRICS.map(([key, label, unit]) => ({
      key,
      label,
      unit,
      group: key === 'sleep_hours' ? ('habits' as const) : ('body' as const),
      source: 'Registro corporal',
    })),
    ...HABIT_METRICS.map(([key, label, unit]) => ({
      key,
      label,
      unit,
      group: 'habits' as const,
      source: 'Recap semanal enviado',
    })),
    ...NUTRIENT_METRICS.map(([key, label, unit]) => ({
      key,
      label,
      unit,
      group: 'nutrition' as const,
      source:
        'Comidas marcadas · versión histórica de dieta · estimación, no ingesta real',
    })),
  ].map((item) => ({
    ...item,
    first: null,
    last: null,
    change: null,
    count: 0,
    incomplete_count: 0,
    points: [],
  }));
}

export function addObservation(
  series: MetricSeries,
  point: MetricObservation,
  chartFrom: string,
  chartTo: string,
) {
  if (point.quality !== 'complete') series.incomplete_count++;
  if (
    point.value !== null &&
    Number.isFinite(point.value) &&
    point.quality === 'complete'
  ) {
    series.count++;
    if (!series.first || point.date < series.first.date) series.first = point;
    if (!series.last || point.date > series.last.date) series.last = point;
    series.change =
      series.first && series.last && series.first.date !== series.last.date
        ? Math.round((series.last.value! - series.first.value!) * 100) / 100
        : null;
  }
  if (point.date >= chartFrom && point.date <= chartTo)
    series.points.push(point);
}

type Nutrient = (typeof NUTRIENT_METRICS)[number][0];
type HistoricalMeal = HistoricalDiet['meals'][number];
type MealNutrients = Pick<
  HistoricalMeal,
  'calories' | 'protein_g' | 'carbs_g' | 'fat_g' | 'ingredients'
>;
const ingredientFields = {
  calories: 'calories_per_100g',
  protein_g: 'protein_per_100g',
  carbs_g: 'carbs_per_100g',
  fat_g: 'fat_per_100g',
} as const;

function nutrientValue(meal: MealNutrients, nutrient: Nutrient): number | null {
  const explicit = meal[nutrient];
  if (
    explicit !== null &&
    explicit !== undefined &&
    Number.isFinite(explicit) &&
    explicit >= 0
  )
    return explicit;
  if (!meal.ingredients.length) return null;
  let total = 0;
  for (const item of meal.ingredients) {
    const grams = item.unit === 'g' ? item.quantity : item.grams_equivalent;
    const per100 = item.ingredient[ingredientFields[nutrient]];
    if (
      grams == null ||
      grams < 0 ||
      !Number.isFinite(grams) ||
      per100 == null ||
      per100 < 0 ||
      !Number.isFinite(per100)
    )
      return null;
    total += (grams * per100) / 100;
  }
  return total;
}

// A group with several marked alternatives is ambiguous, never two meals.
// No current-catalog fallback: absent historical content remains unknown.
export function estimateMarkedNutrients(
  markedIds: string[],
  history: DietHistoryEntry[],
) {
  const marked = new Set(markedIds);
  const candidates = new Map<
    string,
    { group: string; meal: MealNutrients; legacy: boolean }[]
  >();
  for (const entry of history) {
    for (const main of entry.diet.meals) {
      for (const meal of [main, ...main.variants]) {
        if (!marked.has(meal.id)) continue;
        const list = candidates.get(meal.id) ?? [];
        list.push({
          group: `${entry.diet_id}:${main.id}`,
          meal,
          legacy: entry.provenance === 'legacy_available',
        });
        candidates.set(meal.id, list);
      }
    }
  }
  const groups = new Map<string, MealNutrients[]>();
  let unknown = 0;
  let legacy = false;
  for (const id of marked) {
    const options = candidates.get(id);
    if (options?.length !== 1) {
      unknown++;
      continue;
    }
    const selected = options[0];
    legacy ||= selected.legacy;
    const group = groups.get(selected.group) ?? [];
    group.push(selected.meal);
    groups.set(selected.group, group);
  }
  const meals: MealNutrients[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) meals.push(group[0]);
    else unknown++;
  }
  return NUTRIENT_METRICS.map(([key]) => {
    const values = meals.map((meal) => nutrientValue(meal, key));
    const known = values.filter((value): value is number => value !== null);
    const complete =
      unknown === 0 &&
      known.length === values.length &&
      (marked.size > 0 || history.length > 0);
    return {
      key,
      value:
        known.length > 0 || complete
          ? Math.round(known.reduce((a, b) => a + b, 0) * 100) / 100
          : null,
      quality: complete
        ? ('complete' as const)
        : known.length
          ? ('partial' as const)
          : ('missing' as const),
      provenance: legacy ? 'legacy_available' : 'observed',
    };
  });
}
