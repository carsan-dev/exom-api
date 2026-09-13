import { BadRequestException } from '@nestjs/common';
import { LastSetVideoPolicy } from '@prisma/client';

export function normalizeAssignmentInput(input: {
  training_id?: string | null;
  training_ids?: string[];
  trainings?: Array<{
    training_id: string;
    last_set_video_policy?: LastSetVideoPolicy;
    requires_last_set_video?: boolean;
  }>;
  diet_id?: string | null;
  is_rest_day?: boolean;
}) {
  const is_rest_day = input.is_rest_day ?? false;
  const requestedTrainings =
    input.trainings !== undefined
      ? input.trainings.map((item) => ({
          training_id: item.training_id,
          last_set_video_policy:
            item.last_set_video_policy ??
            (item.requires_last_set_video === true
              ? LastSetVideoPolicy.ALWAYS
              : item.requires_last_set_video === false
                ? LastSetVideoPolicy.NEVER
                : LastSetVideoPolicy.AUTO),
        }))
      : null;
  const requestedIds = requestedTrainings
    ? requestedTrainings.map((item) => item.training_id)
    : input.training_ids !== undefined
      ? input.training_ids
      : input.training_id
        ? [input.training_id]
        : [];
  const training_ids = is_rest_day ? [] : requestedIds;
  if (training_ids.length > 5) {
    throw new BadRequestException(
      'No puedes asignar más de 5 entrenamientos por día',
    );
  }
  if (new Set(training_ids).size !== training_ids.length) {
    throw new BadRequestException(
      'No puedes repetir un entrenamiento en el mismo día',
    );
  }
  const training_id = training_ids[0] ?? null;
  const diet_id = is_rest_day ? null : (input.diet_id ?? null);

  if (!is_rest_day && training_ids.length === 0 && !diet_id) {
    throw new BadRequestException(
      'Debes asignar un entrenamiento, una dieta o marcar descanso',
    );
  }

  return {
    training_id,
    training_ids,
    trainings: training_ids.map(
      (id) =>
        requestedTrainings?.find((item) => item.training_id === id) ?? {
          training_id: id,
          last_set_video_policy: LastSetVideoPolicy.AUTO,
        },
    ),
    diet_id,
    is_rest_day,
  };
}
