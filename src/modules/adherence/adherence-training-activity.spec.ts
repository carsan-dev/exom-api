import {
  normalizeAdherenceEvidence,
  trainingActivity,
  type EvaluationBasis,
} from './adherence-evaluation.service';

// Informative training activity of a day (owner decision 2026-11-18,
// alternative a2): computed on read, never part of the evaluation.
const day = '2020-01-01';
const today = '2020-01-02';
const known = (
  units: EvaluationBasis['units'],
  completionMode?: EvaluationBasis['completionMode'],
): EvaluationBasis => ({
  trainingKnown: true,
  rest: false,
  units,
  completionMode,
  nutritionKnown: true,
  groups: [],
  calories: null,
  protein: null,
});
const single = known([
  { id: 'link', trainingId: 'training', occurrences: ['a', 'b', 'c'] },
]);
const session = (id: string, training = 'training') => ({
  training_session_id: id,
  training_id: training,
  rpe: null,
  note: null,
});
const entry = (
  occurrence: string,
  sessionId: string | null = 'session',
  completedAt: unknown = '2020-01-01T12:00:00Z',
) => ({
  ...(sessionId === null ? {} : { training_session_id: sessionId }),
  training_exercise_id: occurrence,
  exercise_id: 'exercise-' + occurrence,
  completed_at: completedAt,
});
const progress = (
  sessions: unknown[],
  entries: unknown[],
  extra: Record<string, unknown> = {},
) => ({
  client_id: 'client',
  date: new Date(day + 'T00:00:00Z'),
  sync_revision: 3,
  training_completed: false,
  trainings_completed: [],
  training_sessions: sessions,
  exercises_completed: entries,
  meals_completed: [],
  ...extra,
});
const activity = (
  basis: EvaluationBasis,
  evidence: ReturnType<typeof progress> | null,
  at = day,
) => trainingActivity(basis, evidence, 'client', at, today);

describe('informative training activity', () => {
  it('reports no activity on a planned day without progress', () => {
    expect(activity(single, null)).toEqual({
      recorded: false,
      unverified: false,
      units: [
        { unit_id: 'link', training_id: 'training', recorded: 0, total: 3 },
      ],
    });
    expect(activity(single, progress([], []))).toEqual(activity(single, null));
  });

  it('distinguishes partial exercises in a session from an empty day', () => {
    const partial = progress([session('session')], [entry('a'), entry('b')]);
    expect(activity(single, partial)).toEqual({
      recorded: true,
      unverified: false,
      units: [
        { unit_id: 'link', training_id: 'training', recorded: 2, total: 3 },
      ],
    });
    // The evaluation itself still sees an incomplete unit.
    expect(
      normalizeAdherenceEvidence(single, partial, [], 'client', day).training,
    ).toEqual([{ id: 'link', completion: 'incomplete' }]);
  });

  it('counts every occurrence of a complete training once', () => {
    const complete = progress(
      [session('session')],
      [entry('a'), entry('b'), entry('c'), entry('c')],
    );
    expect(activity(single, complete)?.units).toEqual([
      { unit_id: 'link', training_id: 'training', recorded: 3, total: 3 },
    ]);
  });

  it('ignores entries without a valid completed_at', () => {
    const invalid = progress(
      [session('session')],
      [entry('a', 'session', 'not a date'), entry('b', 'session', null)],
    );
    expect(activity(single, invalid)).toMatchObject({
      recorded: false,
      units: [{ recorded: 0, total: 3 }],
    });
  });

  it('exposes session-less entries apart as unverified, never as recorded', () => {
    const legacy = progress([], [entry('a', null), entry('b', null)]);
    expect(activity(single, legacy)).toEqual({
      recorded: false,
      unverified: true,
      units: [
        { unit_id: 'link', training_id: 'training', recorded: 0, total: 3 },
      ],
    });
    // Same criterion that makes the unit indeterminate today.
    expect(
      normalizeAdherenceEvidence(single, legacy, [], 'client', day).training,
    ).toEqual([{ id: 'link', completion: 'indeterminate' }]);
    // A session-less entry for an occurrence outside the plan is not flagged.
    expect(
      activity(single, progress([], [entry('foreign', null)]))?.unverified,
    ).toBe(false);
  });

  it('does not credit a session of another training', () => {
    const other = progress([session('session', 'other')], [entry('a')]);
    expect(activity(single, other)).toMatchObject({
      recorded: false,
      units: [{ recorded: 0, total: 3 }],
    });
  });

  it('does not credit a session also claimed by another training', () => {
    const claimed = progress(
      [session('session'), session('session', 'other')],
      [entry('a')],
    );
    expect(activity(single, claimed)).toMatchObject({
      recorded: false,
      units: [{ recorded: 0, total: 3 }],
    });
  });

  it('conservatively discards a session holding entries outside the unit', () => {
    const foreign = progress(
      [session('session')],
      [entry('a'), entry('b'), entry('foreign')],
    );
    expect(activity(single, foreign)).toMatchObject({
      recorded: false,
      units: [{ recorded: 0, total: 3 }],
    });
  });

  it('uses the most advanced candidate session instead of summing sessions', () => {
    const several = progress(
      [session('first'), session('second')],
      [entry('a', 'first'), entry('b', 'second'), entry('c', 'second')],
    );
    expect(activity(single, several)?.units).toEqual([
      { unit_id: 'link', training_id: 'training', recorded: 2, total: 3 },
    ]);
  });

  it('reports every unit under ALL', () => {
    const two = known([
      { id: 'link-1', trainingId: 'training-1', occurrences: ['1a', '1b'] },
      { id: 'link-2', trainingId: 'training-2', occurrences: ['2a'] },
    ]);
    const evidence = progress(
      [session('s1', 'training-1')],
      [entry('1a', 's1')],
    );
    expect(activity(two, evidence)).toEqual({
      recorded: true,
      unverified: false,
      units: [
        { unit_id: 'link-1', training_id: 'training-1', recorded: 1, total: 2 },
        { unit_id: 'link-2', training_id: 'training-2', recorded: 0, total: 1 },
      ],
    });
  });

  describe('ANY (alternative trainings)', () => {
    const any = known(
      [
        { id: 'link-1', trainingId: 'training-1', occurrences: ['1a', '1b'] },
        {
          id: 'link-2',
          trainingId: 'training-2',
          occurrences: ['2a', '2b', '2c'],
        },
        {
          id: 'link-3',
          trainingId: 'training-3',
          occurrences: ['3a', '3b', '3c', '3d'],
        },
      ],
      'ANY',
    );
    const sessions = [
      session('s1', 'training-1'),
      session('s2', 'training-2'),
      session('s3', 'training-3'),
    ];

    it('returns only the most advanced alternative (highest fraction)', () => {
      const evidence = progress(sessions, [
        entry('1a', 's1'),
        entry('2a', 's2'),
        entry('2b', 's2'),
      ]);
      expect(activity(any, evidence)).toEqual({
        recorded: true,
        unverified: false,
        units: [
          {
            unit_id: 'link-2',
            training_id: 'training-2',
            recorded: 2,
            total: 3,
          },
        ],
      });
    });

    it('breaks a fraction tie by the larger count, then by plan order', () => {
      const tie = progress(sessions, [
        entry('1a', 's1'),
        entry('3a', 's3'),
        entry('3b', 's3'),
      ]);
      expect(activity(any, tie)?.units).toEqual([
        { unit_id: 'link-3', training_id: 'training-3', recorded: 2, total: 4 },
      ]);
      expect(activity(any, progress([], []))?.units).toEqual([
        { unit_id: 'link-1', training_id: 'training-1', recorded: 0, total: 2 },
      ]);
    });

    it('treats a single ANY training exactly like ALL', () => {
      const evidence = progress([session('session')], [entry('a')]);
      expect(activity({ ...single, completionMode: 'ANY' }, evidence)).toEqual(
        activity(single, evidence),
      );
    });
  });

  it('is null on rest days, days without training and future days', () => {
    const evidence = progress([session('session')], [entry('a')]);
    expect(activity({ ...single, rest: true, units: [] }, evidence)).toBeNull();
    expect(activity(known([]), evidence)).toBeNull();
    expect(activity(single, null, '2020-01-03')).toBeNull();
  });

  it('keeps only the boolean marks on a day with an unknown plan', () => {
    const unknown: EvaluationBasis = {
      ...known([]),
      trainingKnown: false,
      nutritionKnown: false,
    };
    expect(activity(unknown, null)).toEqual({
      recorded: false,
      unverified: false,
      units: null,
    });
    expect(
      activity(unknown, progress([session('session')], [entry('a')])),
    ).toEqual({ recorded: true, unverified: false, units: null });
    expect(activity(unknown, progress([], [entry('a', null)]))).toEqual({
      recorded: false,
      unverified: true,
      units: null,
    });
    // Ownership still applies: a session claimed by two trainings proves
    // nothing.
    expect(
      activity(
        unknown,
        progress(
          [session('session'), session('session', 'other')],
          [entry('a')],
        ),
      )?.recorded,
    ).toBe(false);
    // Units whose content is unknown keep the session/training binding.
    const unknownUnit: EvaluationBasis = {
      ...unknown,
      units: [{ id: 'link', trainingId: 'training', occurrences: [] }],
    };
    expect(
      activity(
        unknownUnit,
        progress([session('s', 'other')], [entry('a', 's')]),
      ),
    ).toEqual({ recorded: false, unverified: false, units: null });
    expect(
      activity(unknownUnit, progress([session('s')], [entry('a', 's')])),
    ).toEqual({ recorded: true, unverified: false, units: null });
  });

  it('ignores progress of another owner or day', () => {
    const evidence = progress([session('session')], [entry('a')]);
    expect(trainingActivity(single, evidence, 'other', day, today)).toEqual(
      activity(single, null),
    );
    expect(trainingActivity(single, evidence, 'client', today, today)).toEqual(
      activity(single, null, today),
    );
  });
});
