import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import {
  COMPLETION,
  evaluateDailyAdherence,
  type DailyAdherence,
  type PlannedUnit,
} from '../../common/progress/daily-adherence-evaluator';
import {
  aggregateClosedAdherence,
  recentClosedAdherence,
  recentClosedDates,
} from '../../common/progress/closed-adherence-aggregate';
import {
  evaluateTargetIndicators,
  evaluateWeeklyStepsIndicator,
  type TargetIndicators,
  type IndicatorStatus,
  type EffectiveIndicatorConfig,
  type WeeklyStepsIndicator,
} from '../../common/progress/adherence-target-indicators';
import {
  lockClientDayProgress,
  DAY_PROGRESS_TRANSACTION_OPTIONS,
} from '../../common/progress/day-progress-lock';
import { loadTrainingHistory } from '../../common/progress/training-history';
import {
  loadDietHistory,
  indexDietHistory,
  historicalDietFor,
} from '../../common/progress/diet-history';
import {
  AdherencePrescriptionService,
  type StoredPrescription,
} from './adherence-prescription.service';
import { AdherencePeriodQueryDto } from './dto/adherence-period-query.dto';

const CALENDAR = {
  FUTURE: 'future',
  INSUFFICIENT: 'insufficient',
  REST: 'rest',
  NOT_ASSIGNED: 'not_assigned',
  COMPLETE: 'complete',
  INCOMPLETE: 'incomplete',
  PARTIAL: 'partial',
} as const;
const BASIS_SOURCE = {
  ORIGINAL: 'original',
  CURRENT: 'current_provisional',
  UNKNOWN: 'unknown',
} as const;
const SCHEDULE = {
  REST: 'rest',
  ASSIGNED: 'assigned',
  NOT_ASSIGNED: 'not_assigned',
  UNKNOWN: 'unknown',
} as const;
type CalendarStatus = (typeof CALENDAR)[keyof typeof CALENDAR];
type BasisSource = (typeof BASIS_SOURCE)[keyof typeof BASIS_SOURCE];
type ScheduleStatus = (typeof SCHEDULE)[keyof typeof SCHEDULE];

interface EvidenceUnit {
  id: string;
  trainingId: string;
  occurrences: string[];
}
interface Nutrient {
  calories_per_100g: number;
  protein_per_100g: number;
}
interface Ingredient {
  quantity: number;
  unit: string;
  grams_equivalent: number | null;
  ingredient: Nutrient;
}
interface Meal {
  id: string;
  ingredients: Ingredient[];
}
interface MealGroup {
  id: string;
  alternatives: Meal[];
}
export interface EvaluationBasis {
  trainingKnown: boolean;
  rest: boolean;
  units: EvidenceUnit[];
  nutritionKnown: boolean;
  groups: MealGroup[];
  calories: number | null;
  protein: number | null;
}
interface ProgressEvidence {
  client_id: string;
  date: Date;
  sync_revision: number;
  training_completed: boolean;
  trainings_completed: string[];
  training_sessions: unknown;
  exercises_completed: unknown;
  meals_completed: string[];
}
interface ReceiptEvidence {
  id: string;
  owner_id: string;
  date: Date;
  response: unknown;
}
interface NormalizedEvidence {
  training: PlannedUnit[];
  nutrition: PlannedUnit[];
  selectedMeals: string[];
  intake: Intake;
  receiptRevisions: number[];
  progressRevision: number | null;
  executions: ExecutionProof[];
}
interface ExecutionProof {
  unit: string;
  session: string;
  occurrences: string[];
}
interface Intake {
  estimated_calories: number | null;
  estimated_protein_g: number | null;
}
export interface AdherenceDayResult {
  date: string;
  revision: number | null;
  basis: BasisSource;
  evaluation: DailyAdherence;
  indicators: TargetIndicators;
  intake: Intake;
  calendar: CalendarStatus;
  targets: NutritionTargets;
  configuration: EvaluationConfiguration;
  schedule: EvaluationSchedule;
}
interface EvaluationSchedule {
  training: ScheduleStatus;
  nutrition: ScheduleStatus;
}
export interface WeeklyStepTarget {
  date: string;
  goal: number | null;
  steps_min_percent: number | null;
  version: number | null;
  effective_date: string | null;
  status: IndicatorStatus;
}
interface KnownDailyPolicy extends EffectiveIndicatorConfig {
  date: string;
  id: string;
  version: number;
  effective_date: string;
  low_global_percent: number;
}
interface UnknownDailyPolicy {
  date: string;
  id: null;
  version: null;
  effective_date: null;
  steps_goal: null;
  steps_min_percent: null;
  calorie_lower_percent: null;
  calorie_upper_percent: null;
  protein_min_percent: null;
  low_global_percent: null;
}
type DatedEffectivePolicy = KnownDailyPolicy | UnknownDailyPolicy;
interface WeeklyEvaluation {
  start: string;
  recap: RecapEvidence | null;
  indicator: WeeklyStepsIndicator;
  dailyTargets: WeeklyStepTarget[];
  configurationDigest: string;
}
interface NutritionTargets {
  calories: number | null;
  protein_g: number | null;
}
interface RecapEvidence {
  id: string;
  average_daily_steps: number | null;
  submitted_at: Date | null;
  updated_at: Date;
}
interface EvaluationConfiguration {
  known: boolean;
  version: number | null;
  low_global_percent: number | null;
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function objects(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(object) : [];
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (object(value))
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonical(value[key]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value) ?? 'null';
}
function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
const civil = (date: Date) => date.toISOString().slice(0, 10);
const unknownBasis = (): EvaluationBasis => ({
  trainingKnown: false,
  rest: false,
  units: [],
  nutritionKnown: false,
  groups: [],
  calories: null,
  protein: null,
});
function frozenBasis(stored: StoredPrescription): EvaluationBasis {
  const p = stored.prescription;
  return {
    trainingKnown: p.training.units.every(
      (unit) => unit.effective_content.basis === 'known',
    ),
    rest: p.training.rest,
    units: p.training.units.map((unit) => ({
      id: unit.id,
      trainingId: unit.training_id,
      occurrences:
        unit.effective_content.basis === 'known'
          ? unit.effective_content.training.exercises.map((e) => e.id)
          : [],
    })),
    nutritionKnown: p.nutrition.basis === 'known',
    groups: p.nutrition.groups,
    calories: p.nutrition.total_calories ?? null,
    protein: p.nutrition.total_protein_g ?? null,
  };
}
/** DayProgress itself supplies owner/date scope; session and occurrence keys
 * prove explicit execution. Legacy flags alone do not prove that execution.
 * Receipts are immutable ACKs, never commands replayed by this read endpoint. */
export function normalizeAdherenceEvidence(
  basis: EvaluationBasis,
  progress: ProgressEvidence | null,
  receipts: ReceiptEvidence[],
  client: string,
  date: string,
): NormalizedEvidence {
  const own =
    progress?.client_id === client && civil(progress.date) === date
      ? progress
      : null;
  const sessions = objects(own?.training_sessions);
  const entries = objects(own?.exercises_completed);
  const supportedReceipts = receipts.filter(
    (receipt) =>
      receipt.owner_id === client &&
      civil(receipt.date) === date &&
      object(receipt.response) &&
      receipt.response.client_id === client &&
      typeof receipt.response.date === 'string' &&
      receipt.response.date.slice(0, 10) === date &&
      typeof receipt.response.operation_revision === 'number' &&
      receipt.response.operation_revision <= (own?.sync_revision ?? 0),
  );
  const receiptRevisions = [
    ...new Set(
      supportedReceipts.map((receipt) =>
        object(receipt.response) &&
        typeof receipt.response.operation_revision === 'number'
          ? receipt.response.operation_revision
          : 0,
      ),
    ),
  ].sort((a, b) => a - b);
  const executions: ExecutionProof[] = [];
  const training = basis.units.map((unit): PlannedUnit => {
    const candidates = sessions.filter(
      (session) =>
        session.training_id === unit.trainingId &&
        typeof session.training_session_id === 'string' &&
        session.training_session_id.length > 0,
    );
    const complete = candidates.some((session) => {
      const id = session.training_session_id;
      if (
        sessions.some(
          (other) =>
            other.training_session_id === id &&
            other.training_id !== unit.trainingId,
        )
      )
        return false;
      const scoped = entries.filter(
        (entry) => entry.training_session_id === id,
      );
      if (
        scoped.some(
          (entry) =>
            typeof entry.training_exercise_id !== 'string' ||
            !unit.occurrences.includes(entry.training_exercise_id),
        )
      )
        return false;
      const supported =
        unit.occurrences.length > 0 &&
        unit.occurrences.every((occurrence) =>
          scoped.some(
            (entry) =>
              entry.training_exercise_id === occurrence &&
              typeof entry.completed_at === 'string' &&
              Number.isFinite(Date.parse(entry.completed_at)),
          ),
        );
      if (supported && typeof id === 'string')
        executions.push({
          unit: unit.id,
          session: id,
          occurrences: [...unit.occurrences].sort(),
        });
      return supported;
    });
    const unsupported =
      own?.trainings_completed.includes(unit.trainingId) ||
      own?.training_completed ||
      entries.some(
        (entry) =>
          !entry.training_session_id &&
          (typeof entry.training_exercise_id === 'string'
            ? unit.occurrences.includes(entry.training_exercise_id)
            : typeof entry.exercise_id === 'string'),
      );
    return {
      id: unit.id,
      completion: complete
        ? COMPLETION.COMPLETE
        : unsupported
          ? COMPLETION.INDETERMINATE
          : COMPLETION.INCOMPLETE,
    };
  });
  const selectedMeals: string[] = [];
  let calories = 0;
  let protein = 0;
  let intakeKnown = true;
  const nutrition = basis.groups.map((group): PlannedUnit => {
    const marked = group.alternatives.filter((meal) =>
      own?.meals_completed.includes(meal.id),
    );
    if (marked.length !== 1) {
      if (marked.length > 1) intakeKnown = false;
      return {
        id: group.id,
        completion:
          marked.length > 1 ? COMPLETION.INDETERMINATE : COMPLETION.INCOMPLETE,
      };
    }
    const meal = marked[0];
    // An alternative ID shared across roots is not a trustworthy claim.
    if (
      basis.groups.filter((g) => g.alternatives.some((m) => m.id === meal.id))
        .length !== 1
    ) {
      intakeKnown = false;
      return { id: group.id, completion: COMPLETION.INDETERMINATE };
    }
    selectedMeals.push(meal.id);
    if (!meal.ingredients.length) intakeKnown = false;
    for (const ingredient of meal.ingredients) {
      const grams =
        ingredient.unit === 'g'
          ? ingredient.quantity
          : ingredient.grams_equivalent;
      if (
        grams === null ||
        !Number.isFinite(grams) ||
        grams < 0 ||
        !Number.isFinite(ingredient.ingredient.calories_per_100g) ||
        !Number.isFinite(ingredient.ingredient.protein_per_100g)
      )
        intakeKnown = false;
      else {
        calories += (grams * ingredient.ingredient.calories_per_100g) / 100;
        protein += (grams * ingredient.ingredient.protein_per_100g) / 100;
      }
    }
    return { id: group.id, completion: COMPLETION.COMPLETE };
  });
  intakeKnown &&=
    basis.nutritionKnown &&
    Number.isFinite(calories) &&
    Number.isFinite(protein);
  return {
    training,
    nutrition,
    selectedMeals: selectedMeals.sort(),
    receiptRevisions,
    // Old mobile commands may have no receipt. The existing DB revision
    // trigger still orders accepted edits, including a return to prior state.
    progressRevision: own?.sync_revision ?? null,
    executions: executions.sort(
      (a, b) =>
        a.unit.localeCompare(b.unit) || a.session.localeCompare(b.session),
    ),
    intake: {
      estimated_calories: intakeKnown ? calories : null,
      estimated_protein_g: intakeKnown ? protein : null,
    },
  };
}
function weekStart(date: string): string {
  const at = new Date(date + 'T00:00:00Z');
  at.setUTCDate(at.getUTCDate() - ((at.getUTCDay() + 6) % 7));
  return civil(at);
}
function calendar(
  evaluation: DailyAdherence,
  basis: EvaluationBasis,
): CalendarStatus {
  if (evaluation.period === 'future') return CALENDAR.FUTURE;
  if (evaluation.global.status === 'insufficient') return CALENDAR.INSUFFICIENT;
  if (evaluation.global.status === 'not_applicable')
    return basis.rest ? CALENDAR.REST : CALENDAR.NOT_ASSIGNED;
  if (evaluation.global.ratio === 1) return CALENDAR.COMPLETE;
  if (evaluation.global.ratio === 0 && evaluation.period === 'closed')
    return CALENDAR.INCOMPLETE;
  return CALENDAR.PARTIAL;
}
@Injectable()
export class AdherenceEvaluationService {
  constructor(private readonly prisma: PrismaService) {}
  protected utcInstant(): Date {
    return new Date();
  }

  private async authorize(
    tx: Prisma.TransactionClient,
    actor: string,
    role: string,
    client: string,
  ) {
    if (
      ![Role.ADMIN, Role.SUPER_ADMIN, Role.CLIENT].some(
        (value) => value === role,
      ) ||
      (role === Role.CLIENT && actor !== client)
    )
      throw new ForbiddenException('Client access denied');
    // Same order as ProgressService/deletion: shared history barrier, client
    // advisory lock, ordered user rows, then current staff assignment row.
    await lockClientDayProgress(tx, client);
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM users WHERE id IN (${Prisma.join([...new Set([actor, client])].sort())}) ORDER BY id FOR SHARE`,
    );
    const users = await tx.user.findMany({
      where: { id: { in: [actor, client] } },
      select: {
        id: true,
        role: true,
        is_active: true,
        is_locked: true,
        is_archived: true,
        identity_pending: true,
      },
    });
    const source = users.find((u) => u.id === actor);
    const target = users.find((u) => u.id === client);
    if (
      !source ||
      source.role !== role ||
      !source.is_active ||
      source.is_locked ||
      source.is_archived ||
      source.identity_pending ||
      target?.role !== Role.CLIENT ||
      !target.is_active ||
      target.is_archived ||
      target.is_locked ||
      target.identity_pending
    )
      throw new ForbiddenException('Client access denied');
    if (role === Role.ADMIN) {
      const assignment = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM admin_client_assignments WHERE admin_id=${actor} AND client_id=${client} AND is_active=true FOR SHARE`;
      if (!assignment.length)
        throw new ForbiddenException('Client access denied');
    }
  }

  private async todayBasis(
    tx: Prisma.TransactionClient,
    client: string,
    date: Date,
  ): Promise<EvaluationBasis> {
    const assignment = await tx.planAssignment.findUnique({
      where: { client_id_date: { client_id: client, date } },
      include: {
        trainings: {
          orderBy: { position: 'asc' },
          include: { training: { include: { exercises: true } } },
        },
        training: { include: { exercises: true } },
        diet: {
          include: {
            meals: {
              where: { parent_meal_id: null },
              include: {
                ingredients: { include: { ingredient: true } },
                variants: {
                  include: { ingredients: { include: { ingredient: true } } },
                },
              },
            },
          },
        },
      },
    });
    if (!assignment)
      return { ...unknownBasis(), trainingKnown: true, nutritionKnown: true };
    const trainingHistory = await loadTrainingHistory(tx, client, date);
    const units = assignment.trainings.length
      ? assignment.trainings.map((link) => ({
          id: link.id,
          trainingId: link.training_id,
          occurrences: (
            trainingHistory.get(link.training_id) ?? link.training
          ).exercises.map((e: { id: string }) => e.id),
        }))
      : assignment.training
        ? [
            {
              id: assignment.id,
              trainingId: assignment.training.id,
              occurrences: (
                trainingHistory.get(assignment.training.id) ??
                assignment.training
              ).exercises.map((e: { id: string }) => e.id),
            },
          ]
        : [];
    const diet =
      historicalDietFor(
        indexDietHistory(await loadDietHistory(tx, [client], date)),
        assignment,
      ) ?? assignment.diet;
    return {
      trainingKnown: true,
      rest: assignment.is_rest_day,
      units: assignment.is_rest_day ? [] : units,
      nutritionKnown: true,
      groups:
        diet?.meals
          .filter((m) => !m.parent_meal_id)
          .map((meal) => ({
            id: meal.id,
            alternatives: [meal, ...meal.variants],
          })) ?? [],
      calories: diet?.total_calories ?? null,
      protein: diet?.total_protein_g ?? null,
    };
  }

  async get(
    actor: string,
    role: string,
    client: string,
    query: AdherencePeriodQueryDto,
  ) {
    const dates = AdherencePeriodQueryDto.dates(query.start, query.end);
    const instant = this.utcInstant();
    const today = civil(instant);
    const recentDates = recentClosedDates(query.end, today);
    // A disjoint future-only query adds exactly seven historical dates, never
    // the intervening gap. Public DTO validation remains capped at 31 dates.
    const collectedDates = [...new Set([...dates, ...recentDates])].sort();
    return this.prisma.$transaction(
      async (tx) => {
        await this.authorize(tx, actor, role, client);
        const reader = new AdherencePrescriptionService(tx, {
          withTransaction() {
            return Promise.reject(
              new Error('Owner publisher unavailable to HTTP'),
            );
          },
        });
        const days: AdherenceDayResult[] = [];
        const requestedStarts = new Set(dates.map(weekStart));
        const starts = [...new Set(collectedDates.map(weekStart))];
        const policyDates = starts.flatMap((start) =>
          Array.from({ length: 7 }, (_, index) => {
            const at = new Date(start + 'T00:00:00Z');
            at.setUTCDate(at.getUTCDate() + index);
            return civil(at);
          }),
        );
        // Resolve only complete intersecting weeks, not gaps between a future
        // report and recent history. The left join retains unknown policies.
        const policies = await tx.$queryRaw<DatedEffectivePolicy[]>(Prisma.sql`
          SELECT to_char(d.date, 'YYYY-MM-DD') AS date, r.id, r.version,
            to_char(r.effective_date, 'YYYY-MM-DD') AS effective_date,
            r.steps_goal, r.steps_min_percent, r.calorie_lower_percent,
            r.calorie_upper_percent, r.protein_min_percent, r.low_global_percent
          FROM unnest(ARRAY[${Prisma.join(policyDates)}]::date[]) AS d(date)
          LEFT JOIN LATERAL (
            SELECT c.* FROM public.adherence_config_revisions c
            WHERE c.client_id = ${client} AND c.effective_date <= d.date::date
            ORDER BY c.effective_date DESC LIMIT 1
          ) r ON true
          ORDER BY d.date
        `);
        const byDate = new Map(policies.map((policy) => [policy.date, policy]));
        const weekly = new Map<string, WeeklyEvaluation>();
        for (const start of starts) {
          const end = new Date(start + 'T00:00:00Z');
          end.setUTCDate(end.getUTCDate() + 6);
          const recap = await tx.weeklyRecap.findFirst({
            where: {
              client_id: client,
              week_start_date: new Date(start + 'T00:00:00Z'),
              week_end_date: end,
              submitted_at: { not: null },
              status: { in: ['SUBMITTED', 'REVIEWED'] },
            },
            select: {
              id: true,
              average_daily_steps: true,
              submitted_at: true,
              updated_at: true,
            },
          });
          const configurations = policies
            .filter(
              (policy) => policy.date >= start && policy.date <= civil(end),
            )
            .map((policy) => ({
              date: policy.date,
              id: policy.id,
              version: policy.version,
              effective_date: policy.effective_date,
              steps_goal: policy.steps_goal,
              steps_min_percent: policy.steps_min_percent,
            }));
          const indicator = evaluateWeeklyStepsIndicator(
            start,
            configurations,
            recap,
          );
          weekly.set(start, {
            start,
            recap,
            indicator,
            dailyTargets: configurations.map((config) => ({
              date: config.date,
              goal: config.steps_goal,
              steps_min_percent: config.steps_min_percent,
              version: config.version,
              effective_date: config.effective_date,
              status: indicator.status,
            })),
            configurationDigest: digest({
              version: 2,
              start,
              configurations,
              threshold: indicator.threshold,
            }),
          });
        }
        for (const date of collectedDates) {
          const at = new Date(date + 'T00:00:00Z');
          const original =
            date < today ? await reader.read(client, date) : null;
          const basis =
            original?.status === 'stored'
              ? frozenBasis(original)
              : date === today
                ? await this.todayBasis(tx, client, at)
                : unknownBasis();
          const progress =
            date > today
              ? null
              : await tx.dayProgress.findUnique({
                  where: { client_id_date: { client_id: client, date: at } },
                  select: {
                    client_id: true,
                    date: true,
                    sync_revision: true,
                    training_completed: true,
                    trainings_completed: true,
                    training_sessions: true,
                    exercises_completed: true,
                    meals_completed: true,
                  },
                });
          const receipts =
            date > today
              ? []
              : await tx.progressOperation.findMany({
                  where: { owner_id: client, date: at },
                  select: {
                    id: true,
                    owner_id: true,
                    date: true,
                    response: true,
                  },
                  orderBy: { id: 'asc' },
                });
          const evidence = normalizeAdherenceEvidence(
            basis,
            progress,
            receipts,
            client,
            date,
          );
          const policy = byDate.get(date);
          const config = policy && policy.id !== null ? policy : null;
          const week = weekly.get(weekStart(date));
          if (!week) throw new Error('Missing bounded weekly evaluation');
          const recap = week.recap;
          const evaluation = evaluateDailyAdherence({
            date,
            cutoffDate: today,
            training: {
              basis: basis.trainingKnown ? 'known' : 'unknown',
              rest: basis.rest,
              units: evidence.training,
            },
            nutrition: {
              basis: basis.nutritionKnown ? 'known' : 'unknown',
              groups: evidence.nutrition,
            },
          });
          const indicators: TargetIndicators = config
            ? evaluateTargetIndicators({
                prescription: {
                  total_calories: basis.calories,
                  total_protein_g: basis.protein,
                },
                intake: evidence.intake,
                config,
                weeklyRecap: null,
              })
            : {
                calories: { status: 'insufficient' },
                protein: { status: 'insufficient' },
                weeklySteps: { status: 'insufficient' },
              };
          // Calories/protein remain day-specific. Every requested date shares
          // its complete week's steps status; steps never enter global ratios.
          indicators.weeklySteps = { status: week.indicator.status };
          let result: AdherenceDayResult = {
            date,
            revision: null,
            basis:
              original?.status === 'stored'
                ? BASIS_SOURCE.ORIGINAL
                : date === today
                  ? BASIS_SOURCE.CURRENT
                  : BASIS_SOURCE.UNKNOWN,
            evaluation,
            indicators,
            intake: evidence.intake,
            calendar: calendar(evaluation, basis),
            targets: { calories: basis.calories, protein_g: basis.protein },
            schedule: {
              training: basis.rest
                ? SCHEDULE.REST
                : basis.units.length
                  ? SCHEDULE.ASSIGNED
                  : basis.trainingKnown
                    ? SCHEDULE.NOT_ASSIGNED
                    : SCHEDULE.UNKNOWN,
              nutrition: basis.nutritionKnown
                ? basis.groups.length
                  ? SCHEDULE.ASSIGNED
                  : SCHEDULE.NOT_ASSIGNED
                : SCHEDULE.UNKNOWN,
            },
            configuration: {
              known: config !== null,
              version: config?.version ?? null,
              low_global_percent: config?.low_global_percent ?? null,
            },
          };
          if (date < today) {
            const basisDigest =
              original?.status === 'stored'
                ? original.digest
                : 'missing_original';
            const configDigest = digest({
              daily: config
                ? {
                    id: config.id,
                    version: config.version,
                    effective_date: config.effective_date,
                    calorie_lower_percent: config.calorie_lower_percent,
                    calorie_upper_percent: config.calorie_upper_percent,
                    protein_min_percent: config.protein_min_percent,
                    steps_goal: config.steps_goal,
                    steps_min_percent: config.steps_min_percent,
                    low_global_percent: config.low_global_percent,
                  }
                : null,
              weekly: week.configurationDigest,
            });
            const evidenceDigest = digest({
              version: 1,
              evidence,
              weeklySteps: recap
                ? {
                    id: recap.id,
                    average_daily_steps: recap.average_daily_steps,
                    submitted_at: recap.submitted_at?.toISOString() ?? null,
                    updated_at: recap.updated_at.toISOString(),
                  }
                : null,
            });
            const key = digest({
              version: 1,
              client,
              date,
              basisDigest,
              configDigest,
              evidenceDigest,
            });
            const existing = await tx.adherenceEvaluationRevision.findUnique({
              where: {
                client_id_date_idempotency_key: {
                  client_id: client,
                  date: at,
                  idempotency_key: key,
                },
              },
            });
            if (existing)
              result = this.restore(existing.evaluation, existing.revision);
            else {
              const latest = await tx.adherenceEvaluationRevision.findFirst({
                where: { client_id: client, date: at },
                orderBy: { revision: 'desc' },
                select: { revision: true },
              });
              result.revision = (latest?.revision ?? 0) + 1;
              await tx.adherenceEvaluationRevision.create({
                data: {
                  client_id: client,
                  date: at,
                  revision: result.revision,
                  idempotency_key: key,
                  original_basis_id:
                    original?.status === 'stored' ? `${client}:${date}` : null,
                  original_basis_digest: basisDigest,
                  cut_binding:
                    original?.status === 'stored'
                      ? canonical({
                          provenance: original.provenance,
                          manifest_digest: original.manifest_digest,
                        })
                      : null,
                  config_revision_id: config?.id ?? null,
                  config_digest: configDigest,
                  evidence_digest: evidenceDigest,
                  evaluation: this.json(result),
                },
              });
            }
          }
          days.push(result);
        }
        const reportDays = days.filter(
          (day) => day.date >= query.start && day.date <= query.end,
        );
        const evaluations = reportDays.map((day) => day.evaluation);
        const windowEnd = days.find((day) => day.date === recentDates[6]);
        const endPolicy = byDate.get(recentDates[6]);
        const windowConfiguration = windowEnd?.configuration;
        const recentClosed = recentClosedAdherence(
          days.map((day) => day.evaluation),
          query.end,
          today,
          {
            known: windowConfiguration?.known ?? false,
            version: windowConfiguration?.version ?? null,
            low_global_percent: windowConfiguration?.low_global_percent ?? null,
            effective_date:
              endPolicy?.version === windowConfiguration?.version
                ? (endPolicy?.effective_date ?? null)
                : null,
          },
        );
        const weeks = [...weekly.values()]
          .filter((week) => requestedStarts.has(week.start))
          .map((week) => ({
            start: week.start,
            average_daily_steps: week.recap?.average_daily_steps ?? null,
            weeklySteps: week.indicator,
            dailyTargets: week.dailyTargets,
            aggregate: aggregateClosedAdherence(
              reportDays
                .filter((day) => weekStart(day.date) === week.start)
                .map((day) => day.evaluation),
            ),
          }));
        return {
          version: 1,
          start: query.start,
          end: query.end,
          evaluated_at: instant.toISOString(),
          today,
          days: reportDays,
          weeks,
          aggregate: aggregateClosedAdherence(evaluations),
          recentClosed,
        };
      },
      {
        ...DAY_PROGRESS_TRANSACTION_OPTIONS,
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      },
    );
  }

  private json(result: AdherenceDayResult): Prisma.InputJsonValue {
    // Only the typed allowlisted result crosses this serialization boundary.
    return JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue;
  }
  private restore(
    value: Prisma.JsonValue,
    revision: number,
  ): AdherenceDayResult {
    // Rows are written exclusively by this versioned typed serializer. No user
    // JSON, notes, upload URLs or owner objects enter the public payload.
    if (
      !object(value) ||
      typeof value.date !== 'string' ||
      !object(value.evaluation) ||
      !object(value.indicators) ||
      !object(value.intake) ||
      typeof value.basis !== 'string' ||
      typeof value.calendar !== 'string'
    )
      throw new Error('Invalid stored evaluation');
    return { ...value, revision } as unknown as AdherenceDayResult;
  }
}
