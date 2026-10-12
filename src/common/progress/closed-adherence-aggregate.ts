import {
  ADHERENCE_PERIOD,
  ADHERENCE_STATUS,
  combineAdherenceComponents,
  type ComponentAdherence,
  type DailyAdherence,
  type GlobalAdherence,
} from './daily-adherence-evaluator';

// A bounded, explicitly supplied window; this reducer never loads or closes days.
export const MAX_AGGREGATE_DAYS = 366;

export interface ClosedAdherenceAggregate {
  training: ComponentAdherence;
  nutrition: ComponentAdherence;
  global: GlobalAdherence;
}

export const RECENT_CLOSED_STATUS = {
  LOW: 'low',
  NOT_LOW: 'not_low',
  INSUFFICIENT: 'insufficient',
  NOT_APPLICABLE: 'not_applicable',
} as const;

export interface RecentClosedConfiguration {
  known: boolean;
  version: number | null;
  effective_date: string | null;
  low_global_percent: number | null;
}
interface RecentClosedCoverage {
  expected: number;
  available: number;
  evaluable: number;
  not_applicable: number;
  insufficient: number;
}
export interface RecentClosedAdherence {
  start: string;
  end: string;
  anchor: 'selected_end_or_last_closed_utc';
  provisional: false;
  aggregate: ClosedAdherenceAggregate;
  configuration: RecentClosedConfiguration;
  coverage: RecentClosedCoverage;
  status: (typeof RECENT_CLOSED_STATUS)[keyof typeof RECENT_CLOSED_STATUS];
}

// Historical reports anchor at their selected end; current/future reports at
// yesterday UTC. This decision is explicit in the payload for UI date labels.
export function recentClosedDates(end: string, today: string): string[] {
  const last = new Date(today + 'T00:00:00Z');
  last.setUTCDate(last.getUTCDate() - 1);
  const anchor =
    end < last.toISOString().slice(0, 10)
      ? end
      : last.toISOString().slice(0, 10);
  return Array.from({ length: 7 }, (_, index) => {
    const at = new Date(anchor + 'T00:00:00Z');
    at.setUTCDate(at.getUTCDate() - 6 + index);
    return at.toISOString().slice(0, 10);
  });
}

// Only the canonical reducer calculates ratios. Unknown inputs may leave a
// useful partial ratio, but cannot produce a definitive LOW/not-LOW claim.
export function recentClosedAdherence(
  days: readonly DailyAdherence[],
  end: string,
  today: string,
  configuration: RecentClosedConfiguration,
): RecentClosedAdherence {
  const dates = recentClosedDates(end, today);
  const window = days.filter(
    (day) => dates.includes(day.date) && day.period === ADHERENCE_PERIOD.CLOSED,
  );
  const aggregate = aggregateClosedAdherence(window);
  const insufficient =
    window.filter(
      (day) =>
        !day.includeInClosedAggregate ||
        day.training.status === ADHERENCE_STATUS.INSUFFICIENT ||
        day.nutrition.status === ADHERENCE_STATUS.INSUFFICIENT ||
        day.global.caveats.some((caveat) =>
          caveat.startsWith('indeterminate_'),
        ),
    ).length +
    7 -
    window.length;
  const notApplicable = window.filter(
    (day) => day.global.status === ADHERENCE_STATUS.NOT_APPLICABLE,
  ).length;
  const threshold = configuration.known
    ? configuration.low_global_percent
    : null;
  const status =
    insufficient > 0
      ? RECENT_CLOSED_STATUS.INSUFFICIENT
      : aggregate.global.status === ADHERENCE_STATUS.NOT_APPLICABLE
        ? RECENT_CLOSED_STATUS.NOT_APPLICABLE
        : threshold === null ||
            !Number.isFinite(threshold) ||
            aggregate.global.ratio === null
          ? RECENT_CLOSED_STATUS.INSUFFICIENT
          : aggregate.global.ratio < threshold / 100
            ? RECENT_CLOSED_STATUS.LOW
            : RECENT_CLOSED_STATUS.NOT_LOW;
  return {
    start: dates[0],
    end: dates[6],
    anchor: 'selected_end_or_last_closed_utc',
    provisional: false,
    aggregate,
    configuration,
    coverage: {
      expected: 7,
      available: window.length,
      evaluable: window.filter(
        (day) => day.global.status === ADHERENCE_STATUS.EVALUABLE,
      ).length,
      not_applicable: notApplicable,
      insufficient,
    },
    status,
  };
}

function aggregateComponent(
  days: readonly DailyAdherence[],
  component: 'training' | 'nutrition',
): ComponentAdherence {
  let numerator = 0;
  let denominator = 0;
  let insufficient = false;
  const caveats = new Set<string>();
  for (const day of days) {
    const value = day[component];
    for (const caveat of value.caveats) caveats.add(caveat);
    if (value.status === ADHERENCE_STATUS.INSUFFICIENT) {
      insufficient = true;
    } else if (value.status === ADHERENCE_STATUS.EVALUABLE) {
      numerator += value.numerator;
      denominator += value.denominator;
    }
  }
  const status =
    denominator > 0
      ? ADHERENCE_STATUS.EVALUABLE
      : insufficient
        ? ADHERENCE_STATUS.INSUFFICIENT
        : ADHERENCE_STATUS.NOT_APPLICABLE;
  return {
    status,
    numerator,
    denominator,
    ratio: denominator > 0 ? numerator / denominator : null,
    caveats: [...caveats],
  };
}

export function aggregateClosedAdherence(
  days: readonly DailyAdherence[],
): ClosedAdherenceAggregate {
  if (days.length > MAX_AGGREGATE_DAYS) {
    throw new RangeError('Closed adherence window exceeds 366 days');
  }
  const dates = new Set<string>();
  const closed: DailyAdherence[] = [];
  for (const day of days) {
    if (dates.has(day.date)) {
      throw new RangeError('Duplicate UTC civil date in adherence window');
    }
    dates.add(day.date);
    if (
      day.period === ADHERENCE_PERIOD.CLOSED &&
      day.includeInClosedAggregate
    ) {
      closed.push(day);
    }
  }
  const training = aggregateComponent(closed, 'training');
  const nutrition = aggregateComponent(closed, 'nutrition');
  return {
    training,
    nutrition,
    global: combineAdherenceComponents(training, nutrition),
  };
}
