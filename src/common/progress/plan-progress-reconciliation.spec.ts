import {
  countCompletedMealGroups,
  reconcileMealProgress,
  reconcileTrainingProgress,
} from './plan-progress-reconciliation';

describe('plan progress reconciliation', () => {
  it('keeps surviving training ids, removes explicit deletions and recalculates completion', () => {
    const result = reconcileTrainingProgress(
      [
        { training_exercise_id: 'te-1', exercise_id: 'ex-1', weight_used: 20 },
        { training_exercise_id: 'te-2', exercise_id: 'ex-2' },
      ],
      [{ id: 'te-1', exercise_id: 'ex-1' }],
      new Set(['te-2']),
    );

    expect(result.entries).toEqual([
      { training_exercise_id: 'te-1', exercise_id: 'ex-1', weight_used: 20 },
    ]);
    expect(result.trainingCompleted).toBe(true);
  });

  it('repairs a stale training id only when catalog exercise match is unique', () => {
    const unique = reconcileTrainingProgress(
      [{ training_exercise_id: 'old', exercise_id: 'ex-1', sets: [{ set_number: 1, reps: 8 }] }],
      [{ id: 'current', exercise_id: 'ex-1' }],
    );
    expect(unique.entries[0]).toMatchObject({
      training_exercise_id: 'current',
      exercise_id: 'ex-1',
    });

    const ambiguous = reconcileTrainingProgress(
      [{ training_exercise_id: 'old', exercise_id: 'ex-1' }],
      [
        { id: 'current-1', exercise_id: 'ex-1' },
        { id: 'current-2', exercise_id: 'ex-1' },
      ],
    );
    expect(ambiguous.entries).toEqual([
      { training_exercise_id: 'old', exercise_id: 'ex-1' },
    ]);
    expect(ambiguous.trainingCompleted).toBe(false);
  });

  it('remaps a deleted variant to its surviving meal group', () => {
    expect(
      reconcileMealProgress(
        ['variant-1'],
        [
          { id: 'meal-1', parent_meal_id: null },
          { id: 'variant-1', parent_meal_id: 'meal-1' },
        ],
        [{ id: 'meal-1', parent_meal_id: null }],
        new Set(['variant-1']),
      ),
    ).toEqual(['meal-1']);
  });

  it('counts meal groups, ignoring variants and stale ids', () => {
    const meals = [
      { id: 'meal-1', parent_meal_id: null },
      { id: 'variant-1', parent_meal_id: 'meal-1' },
      { id: 'meal-2', parent_meal_id: null },
    ];
    expect(countCompletedMealGroups(['variant-1', 'meal-1', 'stale'], meals)).toBe(1);
  });
});
