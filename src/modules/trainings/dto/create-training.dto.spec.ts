import { TrainingMeasureType } from '@prisma/client';
import { validate } from 'class-validator';
import { TrainingExerciseDto } from './create-training.dto';

function prescription(values: Partial<TrainingExerciseDto> = {}) {
  return Object.assign(new TrainingExerciseDto(), {
    exercise_id: 'exercise-1',
    order: 0,
    sets: 3,
    reps_or_duration: '10',
    measure_type: TrainingMeasureType.REPS,
    target_value: 10,
    rest_seconds: 60,
    ...values,
  });
}

describe('TrainingExerciseDto prescription', () => {
  it.each([undefined, null, 0, 10])(
    'accepts optional target RIR %s',
    async (targetRir) => {
      const dto = prescription(
        targetRir === undefined ? {} : { target_rir: targetRir },
      );

      await expect(validate(dto)).resolves.toHaveLength(0);
    },
  );

  it.each([-1, 11, 2.5])('rejects invalid target RIR %s', async (targetRir) => {
    await expect(
      validate(prescription({ target_rir: targetRir })),
    ).resolves.not.toHaveLength(0);
  });

  it('rejects a target that cannot be stored in a PostgreSQL integer', async () => {
    await expect(
      validate(prescription({ target_value: 2147483648 })),
    ).resolves.not.toHaveLength(0);
  });
});
