// The caller supplies an immutable historical prescription and classified evidence.
// This pure evaluator neither reconstructs legacy provenance nor persists revisions.
export const ADHERENCE_STATUS = {
  EVALUABLE: 'evaluable',
  INSUFFICIENT: 'insufficient',
  NOT_APPLICABLE: 'not_applicable',
  NEUTRAL: 'neutral',
} as const;
export type AdherenceStatus =
  (typeof ADHERENCE_STATUS)[keyof typeof ADHERENCE_STATUS];

export const COMPLETION = {
  COMPLETE: 'complete',
  INCOMPLETE: 'incomplete',
  INDETERMINATE: 'indeterminate',
} as const;
export type Completion = (typeof COMPLETION)[keyof typeof COMPLETION];

export const HISTORICAL_BASIS = { KNOWN: 'known', UNKNOWN: 'unknown' } as const;
export type HistoricalBasis =
  (typeof HISTORICAL_BASIS)[keyof typeof HISTORICAL_BASIS];

export const ADHERENCE_PERIOD = {
  CLOSED: 'closed',
  PROVISIONAL: 'provisional',
  FUTURE: 'future',
} as const;
export type AdherencePeriod =
  (typeof ADHERENCE_PERIOD)[keyof typeof ADHERENCE_PERIOD];

export const GLOBAL_SOURCE = {
  BOTH: 'both',
  TRAINING_ONLY: 'training_only',
  NUTRITION_ONLY: 'nutrition_only',
  NONE: 'none',
} as const;
export type GlobalSource = (typeof GLOBAL_SOURCE)[keyof typeof GLOBAL_SOURCE];

export interface PlannedUnit {
  id: string;
  completion: Completion;
}

export interface TrainingPrescriptionEvidence {
  basis: HistoricalBasis;
  rest: boolean;
  units: readonly PlannedUnit[];
}

// An alternative is a choice within a prescribed group, not another group.
export interface NutritionPrescriptionEvidence {
  basis: HistoricalBasis;
  groups: readonly PlannedUnit[];
}

export interface DailyAdherenceInput {
  date: string;
  cutoffDate: string;
  training: TrainingPrescriptionEvidence;
  nutrition: NutritionPrescriptionEvidence;
}

export interface ComponentAdherence {
  status: AdherenceStatus;
  numerator: number;
  denominator: number;
  ratio: number | null;
  caveats: string[];
}

export interface GlobalAdherence extends ComponentAdherence {
  source: GlobalSource;
}

export interface DailyAdherence {
  date: string;
  period: AdherencePeriod;
  includeInClosedAggregate: boolean;
  training: ComponentAdherence;
  nutrition: ComponentAdherence;
  global: GlobalAdherence;
}

function checkCivilDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new RangeError('Invalid UTC civil date');
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new RangeError('Invalid UTC civil date');
  }
}

function empty(
  status: AdherenceStatus,
  caveats: string[] = [],
): ComponentAdherence {
  return { status, numerator: 0, denominator: 0, ratio: null, caveats };
}

function evaluateUnits(
  units: readonly PlannedUnit[],
  kind: 'training' | 'nutrition',
): ComponentAdherence {
  const seen = new Set<string>();
  let numerator = 0;
  let denominator = 0;
  let indeterminate = false;
  for (const unit of units) {
    if (!unit.id || seen.has(unit.id)) {
      throw new RangeError(`Invalid or duplicate ${kind} group identity`);
    }
    seen.add(unit.id);
    if (unit.completion === COMPLETION.INDETERMINATE) {
      indeterminate = true;
    } else {
      denominator++;
      if (unit.completion === COMPLETION.COMPLETE) numerator++;
      else if (unit.completion !== COMPLETION.INCOMPLETE) {
        throw new RangeError(`Invalid ${kind} evidence`);
      }
    }
  }
  const caveats = indeterminate ? [`indeterminate_${kind}`] : [];
  if (!units.length) return empty(ADHERENCE_STATUS.NOT_APPLICABLE);
  if (!denominator) return empty(ADHERENCE_STATUS.INSUFFICIENT, caveats);
  return {
    status: ADHERENCE_STATUS.EVALUABLE,
    numerator,
    denominator,
    ratio: numerator / denominator,
    caveats,
  };
}

function evaluateTraining(
  input: TrainingPrescriptionEvidence,
): ComponentAdherence {
  if (input.basis === HISTORICAL_BASIS.UNKNOWN) {
    return empty(ADHERENCE_STATUS.INSUFFICIENT, ['unknown_training_basis']);
  }
  if (input.basis !== HISTORICAL_BASIS.KNOWN) {
    throw new RangeError('Invalid historical basis');
  }
  if (input.rest && input.units.length) {
    throw new RangeError('Rest day cannot prescribe training units');
  }
  return evaluateUnits(input.units, 'training');
}

function evaluateNutrition(
  input: NutritionPrescriptionEvidence,
): ComponentAdherence {
  if (input.basis === HISTORICAL_BASIS.UNKNOWN) {
    return empty(ADHERENCE_STATUS.INSUFFICIENT, ['unknown_nutrition_basis']);
  }
  if (input.basis !== HISTORICAL_BASIS.KNOWN) {
    throw new RangeError('Invalid historical basis');
  }
  const groups = evaluateUnits(input.groups, 'nutrition');
  if (groups.status !== ADHERENCE_STATUS.EVALUABLE) return groups;
  // A diet contributes one day, not a fraction of its prescribed meal groups.
  // A known incomplete group proves failure; unknown groups only prevent success.
  const incomplete = groups.numerator < groups.denominator;
  if (!incomplete && groups.caveats.length) {
    return empty(ADHERENCE_STATUS.INSUFFICIENT, groups.caveats);
  }
  return {
    status: ADHERENCE_STATUS.EVALUABLE,
    numerator: incomplete ? 0 : 1,
    denominator: 1,
    ratio: incomplete ? 0 : 1,
    caveats: groups.caveats,
  };
}

export function combineAdherenceComponents(
  training: ComponentAdherence,
  nutrition: ComponentAdherence,
): GlobalAdherence {
  const t = training.status === ADHERENCE_STATUS.EVALUABLE;
  const n = nutrition.status === ADHERENCE_STATUS.EVALUABLE;
  if (t && n) {
    // Exact rational weighting: do not weight components by their unit counts.
    let numerator =
      training.numerator * nutrition.denominator +
      nutrition.numerator * training.denominator;
    let denominator = 2 * training.denominator * nutrition.denominator;
    let a = numerator;
    let b = denominator;
    while (b !== 0) [a, b] = [b, a % b];
    numerator /= a;
    denominator /= a;
    return {
      status: ADHERENCE_STATUS.EVALUABLE,
      source: GLOBAL_SOURCE.BOTH,
      numerator,
      denominator,
      ratio: numerator / denominator,
      caveats: [...training.caveats, ...nutrition.caveats],
    };
  }
  if (t || n) {
    const active = t ? training : nutrition;
    const other = t ? nutrition : training;
    const otherKind = t ? 'nutrition' : 'training';
    return {
      status: ADHERENCE_STATUS.EVALUABLE,
      source: t ? GLOBAL_SOURCE.TRAINING_ONLY : GLOBAL_SOURCE.NUTRITION_ONLY,
      numerator: active.numerator,
      denominator: active.denominator,
      ratio: active.ratio,
      caveats: [
        ...active.caveats,
        `${otherKind}_${other.status}`,
        ...other.caveats,
      ],
    };
  }
  if (
    training.status === ADHERENCE_STATUS.NOT_APPLICABLE &&
    nutrition.status === ADHERENCE_STATUS.NOT_APPLICABLE
  ) {
    return {
      ...empty(ADHERENCE_STATUS.NOT_APPLICABLE),
      source: GLOBAL_SOURCE.NONE,
    };
  }
  return {
    ...empty(ADHERENCE_STATUS.INSUFFICIENT, [
      ...training.caveats,
      ...nutrition.caveats,
    ]),
    source: GLOBAL_SOURCE.NONE,
  };
}

export function evaluateDailyAdherence(
  input: DailyAdherenceInput,
): DailyAdherence {
  checkCivilDate(input.date);
  checkCivilDate(input.cutoffDate);
  if (input.date > input.cutoffDate) {
    return {
      date: input.date,
      period: ADHERENCE_PERIOD.FUTURE,
      includeInClosedAggregate: false,
      training: empty(ADHERENCE_STATUS.NEUTRAL),
      nutrition: empty(ADHERENCE_STATUS.NEUTRAL),
      global: {
        ...empty(ADHERENCE_STATUS.NEUTRAL),
        source: GLOBAL_SOURCE.NONE,
      },
    };
  }
  const training = evaluateTraining(input.training);
  const nutrition = evaluateNutrition(input.nutrition);
  return {
    date: input.date,
    period:
      input.date === input.cutoffDate
        ? ADHERENCE_PERIOD.PROVISIONAL
        : ADHERENCE_PERIOD.CLOSED,
    includeInClosedAggregate: input.date < input.cutoffDate,
    training,
    nutrition,
    global: combineAdherenceComponents(training, nutrition),
  };
}
