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
