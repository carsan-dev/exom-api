import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CompleteTrainingDto,
  CompletedSetDto,
  MarkExerciseDto,
} from './mark-completed.dto';

describe('CompletedSetDto', () => {
  it.each([undefined, null, 0, 10])('accepts optional RIR %s', async (rir) => {
    const dto = Object.assign(new CompletedSetDto(), {
      set_number: 1,
      reps: 10,
      ...(rir === undefined ? {} : { rir }),
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it.each([-1, 11, 2.5])('rejects invalid RIR %s', async (rir) => {
    const dto = Object.assign(new CompletedSetDto(), {
      set_number: 1,
      reps: 10,
      rir,
    });

    await expect(validate(dto)).resolves.not.toHaveLength(0);
  });

  it('rejects two performances for the same set number', async () => {
    const dto = Object.assign(new MarkExerciseDto(), {
      date: '2026-09-05',
      exercise_id: 'exercise-1',
      sets: [
        Object.assign(new CompletedSetDto(), { set_number: 1, reps: 10 }),
        Object.assign(new CompletedSetDto(), { set_number: 1, reps: 8 }),
      ],
    });

    await expect(validate(dto)).resolves.not.toHaveLength(0);
  });
});

describe('CompleteTrainingDto', () => {
  const validateCompletion = (input: Record<string, unknown>) =>
    validate(
      plainToInstance(CompleteTrainingDto, {
        date: '2026-09-23',
        training_id: 'training-1',
        ...input,
      }),
    );

  it('accepts legacy completion without an effort rating', async () => {
    expect(await validateCompletion({ notes: 'Legacy daily note' })).toEqual(
      [],
    );
  });

  it.each([1, 10])('accepts confirmed session RPE %i', async (rpe) => {
    expect(
      await validateCompletion({ rpe, session_note: ' Hard session ' }),
    ).toEqual([]);
  });

  it.each([0, 11, 3.5, '7', null])(
    'rejects invalid session RPE %s',
    async (rpe) => {
      expect(await validateCompletion({ rpe })).not.toEqual([]);
    },
  );

  it('rejects an oversized session note', async () => {
    expect(
      await validateCompletion({ session_note: 'a'.repeat(1001) }),
    ).not.toEqual([]);
  });
});
