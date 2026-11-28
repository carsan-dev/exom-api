import { expect } from '@jest/globals';
import {
  deriveProgramPosition,
  selectProgramRule,
  type ProgramRule,
  type ProgramRuleDay,
} from './program-position';

const utc = (value: string) => new Date(`${value}T00:00:00.000Z`);

const trainingDay = (weekday: number): ProgramRuleDay => ({
  weekday,
  is_rest_day: false,
  training_id: `training-${weekday}`,
  training: { is_active: true },
  trainings: [{ training: { is_active: true } }],
});

const restDay = (weekday: number): ProgramRuleDay => ({
  weekday,
  is_rest_day: true,
  training_id: null,
  training: null,
  trainings: [],
});

const dietOnlyDay = (weekday: number): ProgramRuleDay => ({
  weekday,
  is_rest_day: false,
  training_id: null,
  training: null,
  trainings: [],
});

// Monday, Wednesday and Friday train; the weekend rests.
const mondayWednesdayFriday = (): ProgramRuleDay[] => [
  trainingDay(1),
  dietOnlyDay(2),
  trainingDay(3),
  dietOnlyDay(4),
  trainingDay(5),
  restDay(6),
  restDay(7),
];

const rule = (overrides: Partial<ProgramRule> = {}): ProgramRule => ({
  id: 'rule-1',
  is_active: true,
  created_at: new Date('2026-11-01T10:00:00.000Z'),
  starts_on: utc('2026-11-16'),
  ends_on: null,
  days: mondayWednesdayFriday(),
  ...overrides,
});

describe('deriveProgramPosition', () => {
  it('returns week 1 and day 1 on the first day of the rule', () => {
    expect(deriveProgramPosition(rule(), utc('2026-11-16'))).toEqual({
      program_week: 1,
      program_day: 1,
    });
  });

  it('counts training days by position, Monday first, within the week', () => {
    expect(deriveProgramPosition(rule(), utc('2026-11-18'))).toEqual({
      program_week: 1,
      program_day: 2,
    });
    expect(deriveProgramPosition(rule(), utc('2026-11-20'))).toEqual({
      program_week: 1,
      program_day: 3,
    });
  });

  it('moves to the next week on Monday', () => {
    expect(deriveProgramPosition(rule(), utc('2026-11-23'))).toEqual({
      program_week: 2,
      program_day: 1,
    });
    expect(deriveProgramPosition(rule(), utc('2026-12-30'))).toEqual({
      program_week: 7,
      program_day: 2,
    });
  });

  it('anchors week 1 to the Monday of a mid-week starts_on', () => {
    const midWeek = rule({ starts_on: utc('2026-11-18') });

    expect(deriveProgramPosition(midWeek, utc('2026-11-18'))).toEqual({
      program_week: 1,
      program_day: 2,
    });
    expect(deriveProgramPosition(midWeek, utc('2026-11-22'))).toEqual({
      program_week: 1,
      program_day: null,
    });
    expect(deriveProgramPosition(midWeek, utc('2026-11-23'))).toEqual({
      program_week: 2,
      program_day: 1,
    });
  });

  it('returns null for both fields before starts_on, even in the same week', () => {
    const midWeek = rule({ starts_on: utc('2026-11-18') });

    expect(deriveProgramPosition(midWeek, utc('2026-11-16'))).toEqual({
      program_week: null,
      program_day: null,
    });
    expect(deriveProgramPosition(rule(), utc('2026-11-15'))).toEqual({
      program_week: null,
      program_day: null,
    });
  });

  it('honours an inclusive ends_on', () => {
    const bounded = rule({ ends_on: utc('2026-11-27') });

    expect(deriveProgramPosition(bounded, utc('2026-11-27'))).toEqual({
      program_week: 2,
      program_day: 3,
    });
    expect(deriveProgramPosition(bounded, utc('2026-11-28'))).toEqual({
      program_week: null,
      program_day: null,
    });
  });

  it('returns null for both fields without a rule', () => {
    expect(deriveProgramPosition(null, utc('2026-11-16'))).toEqual({
      program_week: null,
      program_day: null,
    });
  });

  it('keeps the week but no day on rest and diet-only days', () => {
    expect(deriveProgramPosition(rule(), utc('2026-11-17'))).toEqual({
      program_week: 1,
      program_day: null,
    });
    expect(deriveProgramPosition(rule(), utc('2026-11-21'))).toEqual({
      program_week: 1,
      program_day: null,
    });
  });

  it('does not count a rest day that still references a training', () => {
    const days = mondayWednesdayFriday();
    days[2] = { ...trainingDay(3), is_rest_day: true };

    expect(deriveProgramPosition(rule({ days }), utc('2026-11-18'))).toEqual({
      program_week: 1,
      program_day: null,
    });
    expect(deriveProgramPosition(rule({ days }), utc('2026-11-20'))).toEqual({
      program_week: 1,
      program_day: 2,
    });
  });

  it('ignores inactive trainings like the materializer does', () => {
    const days = mondayWednesdayFriday();
    // Every linked training inactive: not a training day, even with an
    // active legacy training_id (desiredAssignment ignores it when links exist).
    days[0] = {
      ...trainingDay(1),
      trainings: [
        { training: { is_active: false } },
        { training: { is_active: false } },
      ],
    };
    // Legacy single training that is inactive.
    days[2] = {
      ...trainingDay(3),
      training: { is_active: false },
      trainings: [],
    };
    // One active link among inactive ones still trains.
    days[4] = {
      ...trainingDay(5),
      trainings: [
        { training: { is_active: false } },
        { training: { is_active: true } },
      ],
    };
    const edited = rule({ days });

    expect(deriveProgramPosition(edited, utc('2026-11-16'))).toEqual({
      program_week: 1,
      program_day: null,
    });
    expect(deriveProgramPosition(edited, utc('2026-11-18'))).toEqual({
      program_week: 1,
      program_day: null,
    });
    expect(deriveProgramPosition(edited, utc('2026-11-20'))).toEqual({
      program_week: 1,
      program_day: 1,
    });
  });

  it('counts a legacy single active training without links', () => {
    const days = mondayWednesdayFriday();
    days[0] = { ...trainingDay(1), trainings: [] };

    expect(deriveProgramPosition(rule({ days }), utc('2026-11-16'))).toEqual({
      program_week: 1,
      program_day: 1,
    });
  });

  it('uses UTC day arithmetic across Sunday/Monday and a year change', () => {
    const yearEnd = rule({
      starts_on: utc('2026-12-28'),
      days: [trainingDay(1), trainingDay(7)],
    });

    expect(deriveProgramPosition(yearEnd, utc('2027-01-03'))).toEqual({
      program_week: 1,
      program_day: 2,
    });
    expect(
      deriveProgramPosition(yearEnd, new Date('2027-01-03T23:59:59.999Z')),
    ).toEqual({ program_week: 1, program_day: 2 });
    expect(deriveProgramPosition(yearEnd, utc('2027-01-04'))).toEqual({
      program_week: 2,
      program_day: 1,
    });
  });

  it('places a Sunday starts_on in the week that began the previous Monday', () => {
    const sundayStart = rule({ starts_on: utc('2027-01-03') });

    expect(deriveProgramPosition(sundayStart, utc('2027-01-03'))).toEqual({
      program_week: 1,
      program_day: null,
    });
    expect(deriveProgramPosition(sundayStart, utc('2027-01-04'))).toEqual({
      program_week: 2,
      program_day: 1,
    });
  });

  it('degrades incoherent rules to null instead of throwing', () => {
    expect(
      deriveProgramPosition(rule({ days: [] }), utc('2026-11-16')),
    ).toEqual({ program_week: 1, program_day: null });
    expect(
      deriveProgramPosition(
        rule({ days: [trainingDay(0), trainingDay(8), trainingDay(1.5)] }),
        utc('2026-11-16'),
      ),
    ).toEqual({ program_week: 1, program_day: null });
    expect(
      deriveProgramPosition(
        rule({ ends_on: utc('2026-11-01') }),
        utc('2026-11-16'),
      ),
    ).toEqual({ program_week: null, program_day: null });
    expect(
      deriveProgramPosition(
        rule({ starts_on: new Date(Number.NaN) }),
        utc('2026-11-16'),
      ),
    ).toEqual({ program_week: null, program_day: null });
  });

  it('only ever yields integers >= 1 or null', () => {
    const subject = rule({ starts_on: utc('2026-11-18') });
    for (let offset = -10; offset < 400; offset += 1) {
      const date = utc('2026-11-16');
      date.setUTCDate(date.getUTCDate() + offset);
      const { program_week, program_day } = deriveProgramPosition(
        subject,
        date,
      );
      for (const value of [program_week, program_day]) {
        if (value !== null) {
          expect(Number.isInteger(value)).toBe(true);
          expect(value).toBeGreaterThanOrEqual(1);
        }
      }
      if (program_week === null) expect(program_day).toBeNull();
    }
  });
});

describe('selectProgramRule (L4b-D6)', () => {
  const oldRule = rule({
    id: 'rule-old',
    is_active: false,
    created_at: new Date('2026-10-01T10:00:00.000Z'),
    starts_on: utc('2026-10-05'),
  });
  const newRule = rule({
    id: 'rule-new',
    is_active: true,
    created_at: new Date('2026-11-15T10:00:00.000Z'),
    starts_on: utc('2026-11-16'),
  });

  it('uses the materializing rule of a past date even after it was replaced', () => {
    const date = utc('2026-11-06');
    const selected = selectProgramRule('rule-old', [oldRule], date);

    expect(selected?.id).toBe('rule-old');
    expect(deriveProgramPosition(selected, date)).toEqual({
      program_week: 5,
      program_day: 3,
    });
  });

  it('uses the replacement active rule for an unmaterialized date', () => {
    const date = utc('2026-11-18');
    const selected = selectProgramRule(null, [newRule], date);

    expect(selected?.id).toBe('rule-new');
    expect(deriveProgramPosition(selected, date)).toEqual({
      program_week: 1,
      program_day: 2,
    });
  });

  it('falls back to the active covering rule for a manual assignment', () => {
    expect(selectProgramRule(null, [newRule], utc('2026-11-20'))?.id).toBe(
      'rule-new',
    );
    expect(selectProgramRule(null, [], utc('2026-11-20'))).toBeNull();
    expect(selectProgramRule(null, [oldRule], utc('2026-11-20'))).toBeNull();
  });

  it('prefers the assignment rule R1 over another active rule R2', () => {
    const r1 = rule({ id: 'rule-r1', is_active: false });
    const r2 = rule({
      id: 'rule-r2',
      created_at: new Date('2026-11-17T10:00:00.000Z'),
      starts_on: utc('2026-11-02'),
    });

    const selected = selectProgramRule('rule-r1', [r2, r1], utc('2026-11-23'));
    expect(selected?.id).toBe('rule-r1');
    expect(deriveProgramPosition(selected, utc('2026-11-23'))).toEqual({
      program_week: 2,
      program_day: 1,
    });
  });

  it('returns null without fallback when the assignment rule no longer covers the date', () => {
    const edited = rule({ id: 'rule-r1', starts_on: utc('2026-11-30') });
    const other = rule({ id: 'rule-r2', starts_on: utc('2026-11-02') });
    const date = utc('2026-11-23');

    const selected = selectProgramRule('rule-r1', [edited, other], date);
    expect(selected?.id).toBe('rule-r1');
    expect(deriveProgramPosition(selected, date)).toEqual({
      program_week: null,
      program_day: null,
    });
    expect(selectProgramRule('rule-missing', [other], date)).toBeNull();
  });

  it('breaks ties between several active rules by created_at desc, then id desc', () => {
    const older = rule({
      id: 'rule-b',
      created_at: new Date('2026-11-01T10:00:00.000Z'),
    });
    const newer = rule({
      id: 'rule-a',
      created_at: new Date('2026-11-10T10:00:00.000Z'),
    });
    const sameTimeHigherId = rule({
      id: 'rule-c',
      created_at: new Date('2026-11-10T10:00:00.000Z'),
    });
    const newestNotCovering = rule({
      id: 'rule-z',
      created_at: new Date('2026-11-12T10:00:00.000Z'),
      starts_on: utc('2026-12-07'),
    });
    const newestInactive = rule({
      id: 'rule-y',
      is_active: false,
      created_at: new Date('2026-11-13T10:00:00.000Z'),
    });
    const date = utc('2026-11-18');

    expect(selectProgramRule(null, [older, newer], date)?.id).toBe('rule-a');
    expect(
      selectProgramRule(
        null,
        [older, newer, sameTimeHigherId, newestNotCovering, newestInactive],
        date,
      )?.id,
    ).toBe('rule-c');
  });
});
