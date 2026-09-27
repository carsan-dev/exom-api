import { calculateTrainingProgress } from './training-progress-overview';

describe('calculateTrainingProgress', () => {
  it('groups performed sets across assignments without conflating sessions', () => {
    const result = calculateTrainingProgress([
      {
        date: '2026-09-22',
        exercises_completed: [
          {
            exercise_id: 'squat',
            training_exercise_id: 'assignment-a',
            training_session_id: 'first',
            completed_at: '2026-09-22T09:00:00.000Z',
            sets: [
              { set_number: 1, weight_kg: 0, reps: 5, rir: 0 },
              { set_number: 2, weight_kg: 80, reps: 3, rir: 2 },
              { set_number: 3, weight_kg: 80, reps: 4 },
              { set_number: 4, weight_kg: 100, seconds: 45, rir: 4 },
            ],
          },
          {
            exercise_id: 'squat',
            training_exercise_id: 'assignment-b',
            training_session_id: 'second',
            completed_at: '2026-09-22T17:00:00.000Z',
            sets: [{ set_number: 1, weight_kg: 80, reps: 4, rir: 0 }],
          },
          {
            exercise_id: 'plank',
            sets: [{ set_number: 1, seconds: 30 }],
          },
        ],
        training_sessions: [
          {
            training_id: 'training',
            training_session_id: 'first',
            rpe: 6,
            note: 'first note',
          },
          {
            training_id: 'training',
            training_session_id: 'second',
            rpe: 8,
            note: 'second note',
          },
          { training_id: 'legacy', rpe: null, note: null },
        ],
        notes: 'Old day-level note',
      },
    ]);

    const plank = result.exercises.find(
      (entry) => entry.exercise_id === 'plank',
    );
    const squat = result.exercises.find(
      (entry) => entry.exercise_id === 'squat',
    );
    expect(plank?.volume).toBeNull();
    expect(plank?.mean_rir).toBeNull();
    expect(plank?.pr).toBeNull();
    expect(plank?.sets[0]).toMatchObject({ seconds: 30, reps: null });
    expect(squat?.volume).toBe(880);
    expect(squat?.mean_rir).toBe(1.5);
    expect(squat?.pr).toEqual({
      weight_kg: 80,
      reps: 4,
      date: '2026-09-22',
      training_session_id: 'first',
      set_number: 3,
    });
    expect(squat?.sets).toHaveLength(5);
    expect(squat?.sets[0]).toMatchObject({ weight_kg: 0, rir: 0 });
    expect(squat?.sets[3]).toMatchObject({ seconds: 45, reps: null });
    expect(squat?.sets[4]).toMatchObject({ training_session_id: 'second' });
    expect(result.mean_rpe).toBe(7);
    expect(result.sessions).toHaveLength(3);
    expect(result.sessions[0]).toMatchObject({
      training_id: 'legacy',
      rpe: null,
      note: null,
    });
    expect(result.sessions[1]).toMatchObject({
      training_session_id: 'first',
      rpe: 6,
      note: 'first note',
    });
    expect(result.sessions[2]).toMatchObject({
      training_session_id: 'second',
      rpe: 8,
      note: 'second note',
    });
  });

  it('omits non-finite volume terms and sums without losing valid volume or finite PRs', () => {
    const result = calculateTrainingProgress([
      {
        date: '2026-09-22',
        exercises_completed: [
          {
            exercise_id: 'term',
            sets: [
              { set_number: 1, weight_kg: 3, reps: 5 },
              { set_number: 2, weight_kg: Number.MAX_VALUE, reps: 2 },
            ],
          },
          {
            exercise_id: 'sum',
            sets: [
              { set_number: 1, weight_kg: 1e308, reps: 1 },
              { set_number: 2, weight_kg: 1e308, reps: 1 },
            ],
          },
        ],
      },
    ]);
    const term = result.exercises.find((entry) => entry.exercise_id === 'term');
    const sum = result.exercises.find((entry) => entry.exercise_id === 'sum');
    expect(term?.volume).toBe(15);
    expect(Number.isFinite(term?.volume)).toBe(true);
    expect(term?.pr).toMatchObject({ weight_kg: Number.MAX_VALUE, reps: 2 });
    expect(sum?.volume).toBe(1e308);
    expect(Number.isFinite(sum?.volume)).toBe(true);
    expect(sum?.pr).toMatchObject({ weight_kg: 1e308, reps: 1 });
  });

  it('fails closed on conflicting confirmed duplicate sessions in either order', () => {
    const first = {
      training_id: 'training',
      training_session_id: 'duplicate',
      rpe: 4,
      note: 'first',
    };
    const unrelated = {
      training_id: 'training',
      training_session_id: 'other',
      rpe: 8,
      note: 'unrelated',
    };
    for (const conflicting of [
      { ...first, rpe: 9 },
      { ...first, note: 'second' },
    ]) {
      for (const ordered of [
        [first, { ...first }, conflicting, unrelated],
        [conflicting, { ...first }, first, unrelated],
      ]) {
        const result = calculateTrainingProgress([
          { date: '2026-09-22', training_sessions: ordered },
        ]);
        expect(result.sessions).toEqual([
          {
            date: '2026-09-22',
            training_id: 'training',
            training_session_id: 'other',
            rpe: 8,
            note: 'unrelated',
          },
        ]);
        expect(result.mean_rpe).toBe(8);
      }
    }
    const identical = calculateTrainingProgress([
      { date: '2026-09-22', training_sessions: [first, { ...first }] },
    ]);
    expect(identical.sessions).toHaveLength(1);
    expect(identical.mean_rpe).toBe(4);
  });

  it('breaks equal-weight and equal-rep PR ties by date then stable key', () => {
    const result = calculateTrainingProgress([
      {
        date: '2026-09-23',
        exercises_completed: [
          {
            exercise_id: 'x',
            training_session_id: 'z',
            sets: [{ set_number: 1, weight_kg: 60, reps: 5 }],
          },
          {
            exercise_id: 'x',
            training_session_id: 'a',
            sets: [{ set_number: 2, weight_kg: 60, reps: 5 }],
          },
        ],
      },
      {
        date: '2026-09-22',
        exercises_completed: [
          {
            exercise_id: 'x',
            training_session_id: 'older',
            sets: [{ set_number: 1, weight_kg: 60, reps: 5 }],
          },
        ],
      },
    ]);
    expect(result.exercises[0].pr).toEqual({
      weight_kg: 60,
      reps: 5,
      date: '2026-09-23',
      training_session_id: 'a',
      set_number: 2,
    });
  });

  it('does not invent data from malformed legacy fields or provisional RPE', () => {
    const result = calculateTrainingProgress([
      {
        date: '2026-09-24',
        notes: 'day only',
        exercises_completed: [
          {
            exercise_id: 'x',
            sets: [
              { set_number: 1, weight_kg: '50', reps: 10, rir: '0' },
              { set_number: 2, weight_kg: 10, reps: -1, rir: 0 },
              { set_number: 3, weight_kg: 10, seconds: 40, reps: 4 },
              { set_number: 4, weight_kg: 30, seconds: 'bad', reps: 5 },
            ],
          },
        ],
        training_sessions: [
          { training_id: 'x', rpe: '9', note: 'invalid' },
          { training_id: 'x', rpe: null, note: null },
          { training_id: 'x', rpe: 7, confirmed: false },
        ],
      },
    ]);
    expect(result.mean_rpe).toBeNull();
    expect(result.exercises[0].volume).toBeNull();
    expect(result.exercises[0].mean_rir).toBe(0);
    expect(result.exercises[0].pr).toBeNull();
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].note).toBeNull();
    expect(calculateTrainingProgress([])).toEqual({
      exercises: [],
      sessions: [],
      mean_rpe: null,
    });
  });
});
