import {
  reconcileMealProgress,
  reconcileTrainingProgress,
} from './plan-progress-reconciliation';

describe('catalog edits preserve recorded history', () => {
  it('keeps deleted occurrences and their series/RIR without attributing them to replacements', () => {
    const history = [
      {
        training_exercise_id: 'removed',
        exercise_id: 'bench',
        sets: [{ set_number: 1, reps: 8, rir: 2 }],
      },
    ];
    const result = reconcileTrainingProgress(
      history,
      [{ id: 'replacement', exercise_id: 'bench' }],
      new Set(['removed']),
    );
    expect(result.entries).toEqual(history);
    expect(result.trainingCompleted).toBe(false);
  });

  it('does not steal an occurrence from another training that uses the same exercise', () => {
    const history = [
      {
        training_exercise_id: 'other-training-occurrence',
        exercise_id: 'bench',
      },
    ];
    const result = reconcileTrainingProgress(history, [
      { id: 'this-training-occurrence', exercise_id: 'bench' },
    ]);
    expect(result.entries).toEqual(history);
    expect(result.trainingCompleted).toBe(false);
  });

  it('preserves historical meal identities after removing a variant or replacing a diet', () => {
    expect(reconcileMealProgress(['variant', 'old-diet-meal'])).toEqual([
      'variant',
      'old-diet-meal',
    ]);
  });
});
