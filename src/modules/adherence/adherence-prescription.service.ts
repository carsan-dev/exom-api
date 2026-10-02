import { Prisma, type PrismaClient } from '@prisma/client';
import { isDeepStrictEqual } from 'node:util';
import type { AdherenceCommitSql } from './adherence-commit-resolver';
import type { AdherenceHistoryCutKey } from './adherence-history-cut';
import {
  validateTimedConfig,
  type TimedConfig,
} from '../trainings/timed-prescription';
import {
  validateRirOverride,
  validateRirSequence,
  type RirOverride,
} from '../assignments/rir-cycle';

const STATUS = { STORED: 'stored', UNKNOWN: 'unknown' } as const;
const BASIS = { KNOWN: 'known', UNKNOWN: 'unknown' } as const;
const OVERLAY_UNKNOWN = {
  CONTENT: 'unproven_original_training_snapshot_and_rir_targets',
  RIR: 'unproven_original_rir_day_targets',
} as const;
const SOURCES = [
  'catalog_colors',
  'diet_groups',
  'diets',
  'exercises',
  'ingredients',
  'meal_ingredients',
  'meals',
  'plan_assignment_trainings',
  'plan_assignments',
  'training_blocks',
  'training_exercises',
  'training_groups',
  'trainings',
  'diet_day_snapshots',
  'rir_day_targets',
  'training_day_snapshots',
] as const;
type Row = Record<string, unknown>;
type State = Map<string, Map<string, Row>>;
interface Envelope {
  value: unknown;
}
interface Event {
  sequence: bigint;
  xid: string;
  source: string;
  old: Row | null;
  next: Row | null;
}
interface Transaction {
  xid: string;
  microseconds: bigint;
  events: Event[];
}
export interface PrescriptionExercise {
  id: string;
  exercise_id: string;
  name: string;
  order: number;
  block_id: string | null;
  position_in_block: number | null;
  sets: number;
  reps_or_duration: string;
  measure_type: string | null;
  target_value: number | null;
  target_value_min: number | null;
  target_value_max: number | null;
  target_rir: number | null;
  request_set_tracking: boolean;
  rest_seconds: number;
  timed_config: TimedConfig | null;
  rir_override: RirOverride | null;
}
export interface PrescriptionBlock {
  id: string;
  order: number;
  type: string;
  name: string | null;
  rounds: number;
  rest_between_rounds_seconds: number;
}
export interface CatalogTrainingProjection {
  authoritative: false;
  id: string;
  name: string;
  type: string;
  types: string[];
  rir_proposal: number[] | null;
  estimated_duration_min: number | null;
  warmup_description: string | null;
  warmup_duration_min: number | null;
  cooldown_description: string | null;
  blocks: PrescriptionBlock[];
  exercises: PrescriptionExercise[];
}
export interface UnprovenTrainingContent {
  basis: typeof BASIS.UNKNOWN;
  reason: typeof OVERLAY_UNKNOWN.CONTENT;
}
export interface UnprovenTrainingRir {
  basis: typeof BASIS.UNKNOWN;
  reason: typeof OVERLAY_UNKNOWN.RIR;
}
type EffectiveTraining = Omit<CatalogTrainingProjection, 'authoritative'>;
export interface KnownTrainingContent {
  basis: typeof BASIS.KNOWN;
  training: EffectiveTraining;
}
export interface KnownTrainingRir {
  basis: typeof BASIS.KNOWN;
}
export interface PrescriptionIngredient {
  id: string;
  ingredient_id: string;
  quantity: number;
  unit: string;
  grams_equivalent: number | null;
  ingredient: PrescriptionIngredientNutrients;
}
export interface PrescriptionIngredientNutrients {
  id: string;
  name: string;
  calories_per_100g: number;
  protein_per_100g: number;
  carbs_per_100g: number;
  fat_per_100g: number;
}
export interface PrescriptionMeal {
  id: string;
  type: string;
  name: string;
  order: number;
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  ingredients: PrescriptionIngredient[];
}
export interface PrescriptionMealGroup {
  id: string;
  alternatives: PrescriptionMeal[];
}
export interface PrescriptionUnit {
  id: string;
  assignment_id: string;
  training_id: string;
  position: number;
  last_set_video_policy: string;
  requires_last_set_video: boolean;
  legacy_video_exempt: boolean;
  effective_content: UnprovenTrainingContent | KnownTrainingContent;
  effective_rir: UnprovenTrainingRir | KnownTrainingRir;
  catalog_projection: CatalogTrainingProjection;
}
export interface PrescriptionTrainingBasis {
  membership_basis: typeof BASIS.KNOWN;
  rest: boolean;
  units: PrescriptionUnit[];
}
export interface PrescriptionNutritionBasis {
  basis: (typeof BASIS)[keyof typeof BASIS];
  reason: string | null;
  diet_id: string | null;
  groups: PrescriptionMealGroup[];
  total_calories?: number;
  total_protein_g?: number;
}
export interface HistoricalPrescription {
  version: 1;
  client_id: string;
  date: string;
  assignment_id: string | null;
  training: PrescriptionTrainingBasis;
  nutrition: PrescriptionNutritionBasis;
}
export interface StoredPrescription {
  status: typeof STATUS.STORED;
  prescription: HistoricalPrescription;
  provenance: AdherenceHistoryCutKey;
  manifest_digest: string;
  digest: string;
}
export interface UnknownPrescription {
  status: typeof STATUS.UNKNOWN;
  reason: string;
}
export type PrescriptionResult = StoredPrescription | UnknownPrescription;
/** Must use a legitimate history-owner SQL connection. No credentials/default
 * runtime fallback. Acknowledged commit is part of the provider contract. */
export interface PrescriptionPublisher {
  withTransaction<T>(work: (sql: AdherenceCommitSql) => Promise<T>): Promise<T>;
}
/** Concrete Prisma adapter: one privileged, coherent session through COMMIT. */
export class PrismaPrescriptionPublisher implements PrescriptionPublisher {
  constructor(private readonly owner: PrismaClient) {}
  withTransaction<T>(
    work: (sql: AdherenceCommitSql) => Promise<T>,
  ): Promise<T> {
    return this.owner.$transaction(work, {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    });
  }
}
const unknown = (reason: string): UnknownPrescription => ({
  status: STATUS.UNKNOWN,
  reason,
});
function object(v: unknown): v is Row {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function text(v: unknown): string {
  if (typeof v !== 'string' || !v)
    throw new Error('essential_prescription_field');
  return v;
}
function integer(v: unknown): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0)
    throw new Error('essential_prescription_field');
  return v;
}
function bool(v: unknown): boolean {
  if (typeof v !== 'boolean') throw new Error('essential_prescription_field');
  return v;
}
function nullableText(v: unknown): string | null {
  return v === null ? null : text(v);
}
function nullableInt(v: unknown): number | null {
  return v === null ? null : integer(v);
}
function strings(v: unknown): string[] {
  if (!Array.isArray(v) || !v.every((s: unknown) => typeof s === 'string'))
    throw new Error('essential_prescription_field');
  return v;
}
function decimal(v: unknown): bigint {
  const s = text(v);
  if (!/^(0|[1-9][0-9]*)$/.test(s)) throw new Error('invalid_history');
  return BigInt(s);
}
function signedDecimal(v: unknown): bigint {
  const s = text(v);
  if (!/^-?(0|[1-9][0-9]*)$/.test(s)) throw new Error('invalid_history');
  return BigInt(s);
}
function dateValid(date: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    !Number.isNaN(Date.parse(date)) &&
    new Date(date).toISOString().slice(0, 10) === date
  );
}
function closure(date: string): string {
  return new Date(Date.parse(date) + 86400000)
    .toISOString()
    .replace('.000Z', '.000000Z');
}
function copy(state: State): State {
  return new Map([...state].map(([table, rows]) => [table, new Map(rows)]));
}
function apply(state: State, tx: Transaction): State | null {
  const trial = copy(state);
  for (const e of tx.events) {
    const rows = trial.get(e.source);
    if (!rows) throw new Error('invalid_history');
    if (e.old) {
      const id = rowKey(e.source, e.old);
      if (!isDeepStrictEqual(rows.get(id), e.old)) return null;
      rows.delete(id); // Crucial: OLD key must not survive a primary-key move.
    }
    if (e.next) {
      const id = rowKey(e.source, e.next);
      if (rows.has(id)) return null;
      rows.set(id, e.next);
    }
  }
  return trial;
}
function touched(tx: Transaction): Set<string> {
  return new Set(
    tx.events.flatMap((e) =>
      [e.old, e.next]
        .filter((r) => r !== null)
        .map((r) => JSON.stringify([e.source, rowKey(e.source, r)])),
    ),
  );
}
/** Only invoked by the concrete publisher, never a current-catalog read path. */
function replay(bundle: Row): State {
  if (
    !Array.isArray(bundle.baseline) ||
    !Array.isArray(bundle.events) ||
    !object(bundle.manifest) ||
    !Array.isArray(bundle.manifest.proofs) ||
    bundle.manifest.proofs.length < 1 ||
    bundle.manifest.proofs.length > 128
  )
    throw new Error('invalid_history');
  const state: State = new Map(SOURCES.map((s) => [s, new Map<string, Row>()]));
  for (const b of bundle.baseline) {
    if (!object(b) || !object(b.row_image)) throw new Error('invalid_baseline');
    if (b.source_table === '__adherence_coverage__') continue;
    const rows = state.get(text(b.source_table));
    const id = text(b.row_key);
    if (
      !rows ||
      id !== rowKey(text(b.source_table), b.row_image) ||
      rows.has(id)
    )
      throw new Error('invalid_baseline');
    rows.set(id, b.row_image);
  }
  const transactions = new Map<string, Transaction>();
  const cutoff = signedDecimal(bundle.manifest.cutoff_microseconds);
  for (const p of bundle.manifest.proofs) {
    if (!object(p) || !object(p.proof)) throw new Error('invalid_history');
    const proof = p.proof;
    const xid = text(proof.full_xid);
    decimal(xid); // Never Number/full-XID ordering as commit chronology.
    if (transactions.has(xid)) throw new Error('invalid_history');
    transactions.set(xid, {
      xid,
      microseconds: signedDecimal(proof.microseconds),
      events: [],
    });
  }
  const sequences = new Set<bigint>();
  for (const value of bundle.events) {
    if (!object(value)) throw new Error('invalid_history');
    const xid = text(value.transaction_id);
    const tx = transactions.get(xid);
    const sequence = decimal(value.event_sequence);
    if (
      !tx ||
      sequences.has(sequence) ||
      !(value.old_row === null || object(value.old_row)) ||
      !(value.new_row === null || object(value.new_row))
    )
      throw new Error('invalid_history');
    sequences.add(sequence);
    const old = value.old_row;
    const next = value.new_row;
    if (
      (value.operation === 'INSERT' && (old !== null || next === null)) ||
      (value.operation === 'UPDATE' && (old === null || next === null)) ||
      (value.operation === 'DELETE' && (old === null || next !== null)) ||
      !['INSERT', 'UPDATE', 'DELETE'].includes(String(value.operation))
    )
      throw new Error('invalid_history');
    tx.events.push({
      xid,
      sequence,
      source: text(value.source_table),
      old,
      next,
    });
  }
  const ordered = [...transactions.values()].filter(
    (t) => t.microseconds <= cutoff && t.events.length,
  );
  ordered.forEach((t) =>
    t.events.sort((a, b) => (a.sequence < b.sequence ? -1 : 1)),
  );
  ordered.sort((a, b) =>
    a.microseconds < b.microseconds
      ? -1
      : a.microseconds > b.microseconds
        ? 1
        : 0,
  );
  let current = state;
  while (ordered.length) {
    const micros = ordered[0].microseconds;
    const group = ordered.splice(
      0,
      ordered.findIndex((t) => t.microseconds !== micros) < 0
        ? ordered.length
        : ordered.findIndex((t) => t.microseconds !== micros),
    );
    while (group.length) {
      const applicable = group.flatMap((tx) => {
        const result = apply(current, tx);
        return result ? [{ tx, result }] : [];
      });
      if (!applicable.length) throw new Error('unproven_causal_history');
      // Independent rows commute. Conflicting ties need an OLD/NEW causal chain,
      // not global sequence or numeric XID order (neither proves commit order).
      for (let i = 0; i < applicable.length; i++) {
        const keys = touched(applicable[i].tx);
        if (
          applicable
            .slice(i + 1)
            .some((other) => [...touched(other.tx)].some((k) => keys.has(k)))
        )
          throw new Error('ambiguous_commit_order');
      }
      const selected = applicable[0];
      current = selected.result;
      group.splice(group.indexOf(selected.tx), 1);
    }
  }
  return current;
}
function catalogTraining(
  state: State,
  trainingId: string,
): CatalogTrainingProjection {
  const rows = (table: string) => [...(state.get(table)?.values() ?? [])];
  const get = (table: string, id: unknown): Row => {
    const row = state.get(table)?.get(text(id));
    if (!row) throw new Error('essential_prescription_field');
    return row;
  };
  const t = get('trainings', trainingId);
  const blocks = rows('training_blocks')
    .filter((b) => b.training_id === trainingId)
    .map(
      (b): PrescriptionBlock => ({
        id: text(b.id),
        order: integer(b.order),
        type: text(b.type),
        name: nullableText(b.name),
        rounds: integer(b.rounds),
        rest_between_rounds_seconds: integer(b.rest_between_rounds_seconds),
      }),
    )
    .sort((x, y) => x.order - y.order);
  const exercises = rows('training_exercises')
    .filter((e) => e.training_id === trainingId)
    .map((e): PrescriptionExercise => {
      const exercise = get('exercises', e.exercise_id);
      const blockId = nullableText(e.block_id);
      if (blockId && !blocks.some((b) => b.id === blockId))
        throw new Error('essential_prescription_field');
      const measure = nullableText(e.measure_type);
      if (measure !== null && !['REPS', 'SECONDS'].includes(measure))
        throw new Error('essential_prescription_field');
      return {
        id: text(e.id),
        exercise_id: text(e.exercise_id),
        name: text(exercise.name),
        order: integer(e.order),
        block_id: blockId,
        position_in_block: nullableInt(e.position_in_block),
        sets: integer(e.sets),
        reps_or_duration: text(e.reps_or_duration),
        measure_type: measure,
        target_value: nullableInt(e.target_value),
        target_value_min: nullableInt(e.target_value_min),
        target_value_max: nullableInt(e.target_value_max),
        target_rir: nullableInt(e.target_rir),
        request_set_tracking: bool(e.request_set_tracking),
        rest_seconds: integer(e.rest_seconds),
        timed_config:
          e.timed_config === null ? null : validateTimedConfig(e.timed_config),
        rir_override:
          e.rir_override === null ? null : validateRirOverride(e.rir_override),
      };
    })
    .sort((x, y) => x.order - y.order);
  return {
    authoritative: false,
    id: trainingId,
    name: text(t.name),
    type: text(t.type),
    types: strings(t.types),
    rir_proposal:
      t.rir_proposal === null ? null : validateRirSequence(t.rir_proposal),
    estimated_duration_min: nullableInt(t.estimated_duration_min),
    warmup_description: nullableText(t.warmup_description),
    warmup_duration_min: nullableInt(t.warmup_duration_min),
    cooldown_description: nullableText(t.cooldown_description),
    blocks,
    exercises,
  };
}

function rowKey(source: string, row: Row): string {
  const field =
    source === 'diet_day_snapshots'
      ? 'diet_id'
      : source === 'training_day_snapshots'
        ? 'training_id'
        : source === 'rir_day_targets'
          ? 'training_exercise_id'
          : null;
  if (!field) return text(row.id);
  const date = text(row.date);
  if (!dateValid(date)) throw new Error('invalid_overlay_key');
  // PostgreSQL canonical jsonb string-array text; no synthetic id on source rows.
  return `[${[text(row.client_id), date, text(row[field])].map((v) => JSON.stringify(v)).join(', ')}]`;
}
function hasCoverage(bundle: Row): boolean {
  if (!Array.isArray(bundle.baseline)) throw new Error('invalid_baseline');
  const baseline: unknown[] = bundle.baseline;
  const markers = baseline.filter(
    (b: unknown) => object(b) && b.source_table === '__adherence_coverage__',
  );
  if (!markers.length) return false;
  if (
    markers.length !== 1 ||
    !object(markers[0]) ||
    !object(markers[0].row_image)
  )
    throw new Error('invalid_coverage');
  const marker = markers[0].row_image;
  const counts = Object.fromEntries(
    SOURCES.map((source) => [
      source,
      baseline.filter((b: unknown) => object(b) && b.source_table === source)
        .length,
    ]),
  );
  if (
    markers[0].row_key !== 'effective-prescription-v2' ||
    !isDeepStrictEqual(marker, {
      id: 'effective-prescription-v2',
      version: 2,
      sources: [...SOURCES],
      counts,
    })
  )
    throw new Error('invalid_coverage');
  return true;
}
function array(v: unknown): Row[] {
  if (!Array.isArray(v) || !v.every(object))
    throw new Error('essential_prescription_field');
  return v;
}
function number(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0)
    throw new Error('essential_prescription_field');
  return v;
}
function nullableNumber(v: unknown): number | null {
  return v === null ? null : number(v);
}
function overlayRow(
  state: State,
  source: string,
  client: string,
  date: string,
  field: string,
  id: string,
): Row | undefined {
  return [...(state.get(source)?.values() ?? [])].find(
    (r) => r.client_id === client && r.date === date && r[field] === id,
  );
}
function effectiveTraining(
  state: State,
  client: string,
  date: string,
  id: string,
  catalog: CatalogTrainingProjection,
): EffectiveTraining {
  const snapshot = overlayRow(
    state,
    'training_day_snapshots',
    client,
    date,
    'training_id',
    id,
  );
  let projection = catalog;
  // Mirrors loadTrainingHistory's version=1 and snapshot-first replacement.
  if (snapshot && integer(snapshot.version) === 1) {
    if (!object(snapshot.payload) || snapshot.payload.id !== id)
      throw new Error('essential_prescription_field');
    const payload = snapshot.payload;
    const isolated: State = new Map(
      SOURCES.map((s) => [s, new Map<string, Row>()]),
    );
    isolated.get('trainings')!.set(id, payload);
    const occurrences = array(payload.exercises);
    const blocks = array(payload.blocks);
    const flat = new Map(occurrences.map((e) => [text(e.id), e]));
    if (flat.size !== occurrences.length)
      throw new Error('invalid_snapshot_occurrences');
    for (const b of blocks) {
      if (
        b.training_id !== id ||
        isolated.get('training_blocks')!.has(text(b.id))
      )
        throw new Error('invalid_snapshot_blocks');
      isolated.get('training_blocks')!.set(text(b.id), b);
      for (const e of array(b.exercises)) {
        const original = flat.get(text(e.id));
        if (
          !original ||
          original.block_id !== b.id ||
          !isDeepStrictEqual(
            { ...original, block: undefined },
            { ...e, block: undefined },
          )
        )
          throw new Error('invalid_snapshot_occurrences');
      }
      const nestedIds = array(b.exercises).map((e) => text(e.id));
      if (
        new Set(nestedIds).size !== nestedIds.length ||
        occurrences
          .filter((e) => e.block_id === b.id)
          .some((e) => !nestedIds.includes(text(e.id)))
      )
        throw new Error('invalid_snapshot_occurrences');
    }
    for (const e of occurrences) {
      if (
        e.training_id !== id ||
        !object(e.exercise) ||
        e.exercise.id !== e.exercise_id
      )
        throw new Error('essential_prescription_field');
      isolated.get('training_exercises')!.set(text(e.id), e);
      isolated.get('exercises')!.set(text(e.exercise_id), e.exercise);
    }
    projection = catalogTraining(isolated, id);
  }
  const { authoritative: _authoritative, ...training } = projection;
  void _authoritative;
  return {
    ...training,
    exercises: training.exercises.map((e) => {
      const target = overlayRow(
        state,
        'rir_day_targets',
        client,
        date,
        'training_exercise_id',
        e.id,
      );
      // Actual reader keys by occurrence, NOT catalog exercise or training id.
      return target ? { ...e, target_rir: nullableInt(target.target_rir) } : e;
    }),
  };
}
function effectiveNutrition(
  state: State,
  client: string,
  date: string,
  id: string,
): PrescriptionNutritionBasis {
  const snapshot = overlayRow(
    state,
    'diet_day_snapshots',
    client,
    date,
    'diet_id',
    id,
  );
  let diet: Row;
  if (snapshot) {
    if (!object(snapshot.diet)) throw new Error('essential_prescription_field');
    diet = snapshot.diet;
  } else {
    const catalog = state.get('diets')?.get(id);
    if (!catalog) throw new Error('essential_prescription_field');
    const meals = [...(state.get('meals')?.values() ?? [])].filter(
      (m) => m.diet_id === id,
    );
    const links = [...(state.get('meal_ingredients')?.values() ?? [])];
    const enrich = (m: Row): Row => ({
      ...m,
      ingredients: links
        .filter((l) => l.meal_id === m.id)
        .map((l) => {
          const ingredient = state
            .get('ingredients')
            ?.get(text(l.ingredient_id));
          if (!ingredient) throw new Error('essential_prescription_field');
          return { ...l, ingredient };
        }),
    });
    const roots = meals.filter((m) => m.parent_meal_id === null);
    if (
      meals.some(
        (m) =>
          m.parent_meal_id !== null &&
          !roots.some((r) => r.id === m.parent_meal_id),
      )
    )
      throw new Error('essential_prescription_field');
    diet = {
      ...catalog,
      meals: roots.map((m) => ({
        ...enrich(m),
        variants: meals.filter((v) => v.parent_meal_id === m.id).map(enrich),
      })),
    };
  }
  if (diet.id !== id) throw new Error('essential_prescription_field');
  const seen = new Set<string>();
  const meal = (m: Row, parent: string | null): PrescriptionMeal => {
    const mealId = text(m.id);
    if (seen.has(mealId) || m.diet_id !== id || m.parent_meal_id !== parent)
      throw new Error('invalid_meal_membership');
    seen.add(mealId);
    return {
      id: mealId,
      name: text(m.name),
      type: text(m.type),
      order: integer(m.order),
      calories: nullableNumber(m.calories),
      protein_g: nullableNumber(m.protein_g),
      carbs_g: nullableNumber(m.carbs_g),
      fat_g: nullableNumber(m.fat_g),
      ingredients: array(m.ingredients).map((l): PrescriptionIngredient => {
        if (
          l.meal_id !== mealId ||
          !object(l.ingredient) ||
          l.ingredient.id !== l.ingredient_id
        )
          throw new Error('essential_prescription_field');
        const i = l.ingredient;
        return {
          id: text(l.id),
          ingredient_id: text(l.ingredient_id),
          quantity: number(l.quantity),
          unit: text(l.unit),
          grams_equivalent: nullableNumber(l.grams_equivalent),
          ingredient: {
            id: text(i.id),
            name: text(i.name),
            calories_per_100g: number(i.calories_per_100g),
            protein_per_100g: number(i.protein_per_100g),
            carbs_per_100g: number(i.carbs_per_100g),
            fat_per_100g: number(i.fat_per_100g),
          },
        };
      }),
    };
  };
  const groups = array(diet.meals)
    .sort((a, b) => integer(a.order) - integer(b.order))
    .map(
      (m): PrescriptionMealGroup => ({
        id: text(m.id),
        alternatives: [
          meal(m, null),
          ...array(m.variants)
            .sort((a, b) => integer(a.order) - integer(b.order))
            .map((v) => meal(v, text(m.id))),
        ],
      }),
    );
  return {
    basis: BASIS.KNOWN,
    reason: null,
    diet_id: id,
    total_calories: number(diet.total_calories),
    total_protein_g: number(diet.total_protein_g),
    groups,
  };
}
function project(
  state: State,
  client: string,
  date: string,
  covered: boolean,
): HistoricalPrescription {
  const rows = (table: string) => [...(state.get(table)?.values() ?? [])];
  const assignmentRows = rows('plan_assignments');
  for (const a of assignmentRows) {
    text(a.client_id);
    if (!dateValid(text(a.date)))
      throw new Error('essential_prescription_field');
  }
  for (const l of rows('plan_assignment_trainings')) text(l.assignment_id);
  for (const e of rows('training_exercises')) text(e.training_id);
  for (const b of rows('training_blocks')) text(b.training_id);
  const assignments = assignmentRows.filter(
    (a) => a.client_id === client && a.date === date,
  );
  if (assignments.length > 1) throw new Error('invalid_assignment_membership');
  const a = assignments[0];
  const units: PrescriptionUnit[] = [];
  if (a) {
    const links = rows('plan_assignment_trainings').filter(
      (l) => l.assignment_id === a.id,
    );
    links.sort((x, y) => integer(x.position) - integer(y.position));
    // Ordered links carry actual session identity and prescribed video policy.
    // A mirror alone cannot prove those fields: do not invent a legacy link.
    if (!links.length && a.training_id !== null)
      throw new Error('unproven_training_unit_identity');
    const positions = new Set<number>();
    const ids = new Set<string>();
    for (const l of links) {
      const position = integer(l.position);
      const trainingId = text(l.training_id);
      if (positions.has(position) || ids.has(trainingId))
        throw new Error('invalid_assignment_membership');
      positions.add(position);
      ids.add(trainingId);
      const catalog = catalogTraining(state, trainingId);
      const effective = covered
        ? effectiveTraining(state, client, date, trainingId, catalog)
        : null;
      units.push({
        id: text(l.id),
        assignment_id: text(a.id),
        training_id: trainingId,
        position,
        last_set_video_policy: text(l.last_set_video_policy),
        requires_last_set_video: bool(l.requires_last_set_video),
        legacy_video_exempt: bool(l.legacy_video_exempt),
        effective_content: effective
          ? { basis: BASIS.KNOWN, training: effective }
          : {
              basis: BASIS.UNKNOWN,
              reason: OVERLAY_UNKNOWN.CONTENT,
            },
        effective_rir: effective
          ? { basis: BASIS.KNOWN }
          : { basis: BASIS.UNKNOWN, reason: OVERLAY_UNKNOWN.RIR },
        catalog_projection: catalog,
      });
    }
  }
  const rest = a ? bool(a.is_rest_day) : false;
  if (rest && units.length) throw new Error('invalid_rest_prescription');
  const diet = a ? nullableText(a.diet_id) : null;
  return {
    version: 1,
    client_id: client,
    date,
    assignment_id: a ? text(a.id) : null,
    training: { membership_basis: BASIS.KNOWN, rest, units },
    nutrition:
      diet && covered
        ? effectiveNutrition(state, client, date, diet)
        : {
            basis: diet ? BASIS.UNKNOWN : BASIS.KNOWN,
            reason: diet ? 'unproven_original_diet_snapshot_precedence' : null,
            diet_id: diet,
            groups: [],
          },
  };
}
function stored(
  value: unknown,
  client: string,
  date: string,
): PrescriptionResult {
  if (
    !object(value) ||
    !object(value.prescription) ||
    value.prescription.client_id !== client ||
    value.prescription.date !== date ||
    !object(value.provenance) ||
    typeof value.digest !== 'string' ||
    typeof value.manifest_digest !== 'string'
  )
    return unknown('invalid_stored_basis');
  // SQL's only writer is owner controlled; this is a versioned read-model boundary.
  return {
    status: STATUS.STORED,
    prescription: value.prescription as unknown as HistoricalPrescription,
    provenance: value.provenance as unknown as AdherenceHistoryCutKey,
    digest: value.digest,
    manifest_digest: value.manifest_digest,
  };
}
/** Original13 proves membership only; its content stays UNKNOWN. Fresh16
 * coverage is an activation-baseline marker hashed by the original cut proof,
 * not a historical assertion about a legacy snapshot's captured_at. Replay uses
 * snapshot-first readers then day RIR; catalog stays separate/nonauthoritative.
 * Internal T2 boundary, not HTTP authorization. The bounded application reader
 * never reads baseline, journals, current catalog, User, Profile or snapshots. */
export class AdherencePrescriptionService {
  constructor(
    private readonly reader: AdherenceCommitSql,
    private readonly publisher: PrescriptionPublisher,
  ) {}
  async read(client: string, date: string): Promise<PrescriptionResult> {
    if (!client || !dateValid(date)) return unknown('invalid_client_date');
    const rows = await this.reader.$queryRaw<
      Envelope[]
    >`SELECT payload AS value FROM public.adherence_historical_prescriptions WHERE client_id = ${client} AND date = ${date}::date`;
    return rows.length === 1
      ? stored(rows[0].value, client, date)
      : unknown('missing_stored_basis');
  }
  async publish(
    client: string,
    date: string,
    binding: AdherenceHistoryCutKey,
  ): Promise<PrescriptionResult> {
    if (
      !client ||
      !dateValid(date) ||
      closure(date) !== binding.cutoffUtc ||
      !binding.epochId ||
      !binding.origin
    )
      return unknown('invalid_closed_day_binding');
    return this.publisher.withTransaction(async (sql) => {
      const rows = await sql.$queryRaw<
        Envelope[]
      >`SELECT public.adherence_prescription_source(${binding.epochId}, ${binding.origin}, ${binding.cutoffUtc}) AS value`;
      const bundle = rows[0]?.value;
      if (
        rows.length !== 1 ||
        !object(bundle) ||
        bundle.state !== 'source' ||
        !object(bundle.manifest) ||
        typeof bundle.manifest.manifest_digest !== 'string' ||
        !/^[0-9a-f]{64}$/.test(bundle.manifest.manifest_digest)
      )
        return unknown('unproven_original_cut');
      let prescription: HistoricalPrescription;
      try {
        prescription = project(
          replay(bundle),
          client,
          date,
          hasCoverage(bundle),
        );
      } catch (error) {
        return unknown(
          error instanceof Error ? error.message : 'invalid_prescription',
        );
      }
      const result = await sql.$queryRaw<
        Envelope[]
      >`SELECT public.publish_adherence_prescription(${client}, ${date}::date, ${binding.epochId}, ${binding.origin}, ${binding.cutoffUtc}, ${JSON.stringify(prescription)}::jsonb, ${text(bundle.manifest.manifest_digest)}) AS value`;
      if (result.length !== 1)
        throw new Error('Prescription persistence unavailable');
      const decoded = stored(result[0].value, client, date);
      if (decoded.status !== STATUS.STORED)
        throw new Error('Invalid persisted prescription');
      return decoded;
    });
  }
}
