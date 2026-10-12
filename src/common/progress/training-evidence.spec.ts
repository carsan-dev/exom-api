import { Prisma, TrainingCompletionMode } from '@prisma/client';
import { recomputeTrainingCompletionAfterModeChange } from './training-evidence';

type Tx = Parameters<typeof recomputeTrainingCompletionAfterModeChange>[0];

const date = new Date('2026-10-05T00:00:00.000Z');
const training = (n: string) => ({
  training: {
    id: `training-${n}`,
    exercises: [{ id: `te-${n}`, exercise_id: `exercise-${n}` }],
  },
});

function fakeTx(options: {
  progress: Record<string, unknown> | null;
  mode: TrainingCompletionMode;
  snapshots?: Array<{ training_id: string; payload: unknown }>;
}) {
  const update = jest.fn().mockResolvedValue({});
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue(options.snapshots ?? []),
    dayProgress: {
      findUnique: jest.fn().mockResolvedValue(options.progress),
      update,
    },
    planAssignment: {
      findUnique: jest.fn().mockResolvedValue({
        training_id: null,
        training_completion_mode: options.mode,
        trainings: [training('1'), training('2'), training('3')],
        training: null,
      }),
    },
  };
  return { tx: tx as unknown as Tx, update };
}

const progressWith = (
  entries: Prisma.JsonArray,
  extra: Record<string, unknown> = {},
) => ({
  id: 'progress-1',
  training_completed: false,
  exercises_completed: entries,
  training_sessions: [],
  ...extra,
});

describe('recomputeTrainingCompletionAfterModeChange', () => {
  it('promotes an ANY day from execution evidence of one assigned training', async () => {
    const { tx, update } = fakeTx({
      mode: TrainingCompletionMode.ANY,
      progress: progressWith([
        { training_exercise_id: 'te-2', exercise_id: 'exercise-2' },
      ]),
    });

    await expect(
      recomputeTrainingCompletionAfterModeChange(tx, 'client-1', date),
    ).resolves.toBe(true);
    // Only the flag: exercise and training history are never rewritten.
    expect(update).toHaveBeenCalledWith({
      where: { id: 'progress-1' },
      data: { training_completed: true },
    });
  });

  it('does not promote an ALL day with one of three trainings performed', async () => {
    const { tx, update } = fakeTx({
      mode: TrainingCompletionMode.ALL,
      progress: progressWith([
        { training_exercise_id: 'te-2', exercise_id: 'exercise-2' },
      ]),
    });

    await expect(
      recomputeTrainingCompletionAfterModeChange(tx, 'client-1', date),
    ).resolves.toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it('never demotes an already completed day (promote-only)', async () => {
    const { tx, update } = fakeTx({
      mode: TrainingCompletionMode.ALL,
      progress: progressWith([], { training_completed: true }),
    });

    await expect(
      recomputeTrainingCompletionAfterModeChange(tx, 'client-1', date),
    ).resolves.toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it('does not promote from stored trainings_completed IDs without evidence', async () => {
    const { tx, update } = fakeTx({
      mode: TrainingCompletionMode.ANY,
      progress: progressWith([], { trainings_completed: ['training-1'] }),
    });

    await expect(
      recomputeTrainingCompletionAfterModeChange(tx, 'client-1', date),
    ).resolves.toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it('ignores exercises of an unconfirmed session like the live writers', async () => {
    const { tx, update } = fakeTx({
      mode: TrainingCompletionMode.ANY,
      progress: progressWith([
        {
          training_session_id: 'pending',
          training_exercise_id: 'te-1',
          exercise_id: 'exercise-1',
        },
      ]),
    });

    await expect(
      recomputeTrainingCompletionAfterModeChange(tx, 'client-1', date),
    ).resolves.toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it('judges the snapshot prescription, not a later catalog edit', async () => {
    const { tx, update } = fakeTx({
      mode: TrainingCompletionMode.ANY,
      snapshots: [
        {
          training_id: 'training-1',
          payload: {
            id: 'training-1',
            exercises: [
              { id: 'te-1', exercise_id: 'exercise-1' },
              { id: 'te-1b', exercise_id: 'exercise-1b' },
            ],
          },
        },
      ],
      progress: progressWith([
        { training_exercise_id: 'te-1', exercise_id: 'exercise-1' },
      ]),
    });

    await expect(
      recomputeTrainingCompletionAfterModeChange(tx, 'client-1', date),
    ).resolves.toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it('is a no-op without a progress row', async () => {
    const { tx, update } = fakeTx({
      mode: TrainingCompletionMode.ANY,
      progress: null,
    });

    await expect(
      recomputeTrainingCompletionAfterModeChange(tx, 'client-1', date),
    ).resolves.toBe(false);
    expect(update).not.toHaveBeenCalled();
  });
});
