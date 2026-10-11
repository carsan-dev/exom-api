import { TrainingCompletionMode } from '@prisma/client';
import {
  isTrainingDayComplete,
  trainingCompletionSummary,
} from './training-completion';

describe('isTrainingDayComplete', () => {
  const { ALL, ANY } = TrainingCompletionMode;

  it.each([
    [ALL, [], [], false],
    [ANY, [], [], false],
    [ALL, [], ['a'], false],
    [ANY, [], ['a'], false],
    [ALL, ['a', 'b', 'c'], [], false],
    [ANY, ['a', 'b', 'c'], [], false],
    [ALL, ['a', 'b', 'c'], ['b'], false],
    [ANY, ['a', 'b', 'c'], ['b'], true],
    [ALL, ['a', 'b', 'c'], ['a', 'b', 'c'], true],
    [ANY, ['a', 'b', 'c'], ['c', 'b', 'a'], true],
    [ALL, ['a'], ['a'], true],
    [ANY, ['a'], ['a'], true],
    [ALL, ['a', 'b'], ['a', 'a'], false],
    [ANY, ['a', 'b'], ['x'], false],
    [ALL, ['a', 'b'], ['x', 'y'], false],
  ])(
    'mode %s with assigned %j and completed %j is %s',
    (mode, assigned, completed, expected) => {
      expect(isTrainingDayComplete(mode, assigned, completed)).toBe(expected);
      expect(isTrainingDayComplete(mode, assigned, new Set(completed))).toBe(
        expected,
      );
    },
  );

  it('treats an unknown or absent mode as ALL (legacy rows and row images)', () => {
    expect(isTrainingDayComplete(undefined, ['a', 'b'], ['a'])).toBe(false);
    expect(isTrainingDayComplete(null, ['a', 'b'], ['a', 'b'])).toBe(true);
  });
});

describe('trainingCompletionSummary', () => {
  it('counts only stored completions that belong to the assignment', () => {
    expect(
      trainingCompletionSummary(
        TrainingCompletionMode.ANY,
        ['a', 'b', 'c'],
        ['b', 'old-plan', 'b'],
      ),
    ).toEqual({
      training_completion_mode: 'ANY',
      assigned_count: 3,
      completed_count: 1,
      assigned_training_ids: ['a', 'b', 'c'],
      completed_training_ids: ['b'],
    });
  });

  it('defaults legacy data to ALL and keeps assignment order', () => {
    expect(trainingCompletionSummary(null, ['b', 'a'], ['a', 'b'])).toEqual({
      training_completion_mode: 'ALL',
      assigned_count: 2,
      completed_count: 2,
      assigned_training_ids: ['b', 'a'],
      completed_training_ids: ['b', 'a'],
    });
  });
});
