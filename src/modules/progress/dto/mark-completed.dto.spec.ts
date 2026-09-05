import { validate } from 'class-validator';
import { CompletedSetDto, MarkExerciseDto } from './mark-completed.dto';

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
