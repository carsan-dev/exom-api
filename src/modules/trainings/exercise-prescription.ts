import { BadRequestException } from '@nestjs/common';
import { TrainingMeasureType } from '@prisma/client';

type TrainingPrescriptionInput = {
  timed_config?: unknown;
  reps_or_duration: string;
  measure_type?: TrainingMeasureType;
  target_value?: number;
  target_value_min?: number;
  target_value_max?: number;
  target_rir?: number | null;
};

type ExistingExercisePrescription = {
  timed_config?: unknown;
  reps_or_duration: string;
  measure_type: TrainingMeasureType | null;
  target_value: number | null;
  target_value_min: number | null;
  target_value_max: number | null;
  target_rir: number | null;
};

export function parseLegacyPrescription(value: string): {
  measure_type: TrainingMeasureType;
  target_value: number | null;
  target_value_min: number | null;
  target_value_max: number | null;
} | null {
  const parseTarget = (raw: string, multiplier = 1) => {
    const parsed = Number(raw) * multiplier;
    return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 2147483647
      ? parsed
      : null;
  };
  const seconds = value.match(
    /^\s*(\d+)\s*(?:s|seg|sec|segundo(?:s)?|second(?:s)?)\s*$/i,
  );
  if (seconds) {
    const targetValue = parseTarget(seconds[1]);
    if (targetValue == null) return null;
    return {
      measure_type: TrainingMeasureType.SECONDS,
      target_value: targetValue,
      target_value_min: null,
      target_value_max: null,
    };
  }

  const minutes = value.match(
    /^\s*(\d+)\s*(?:min|mins|minute(?:s)?|minuto(?:s)?)\s*$/i,
  );
  if (minutes) {
    const targetValue = parseTarget(minutes[1], 60);
    if (targetValue == null) return null;
    return {
      measure_type: TrainingMeasureType.SECONDS,
      target_value: targetValue,
      target_value_min: null,
      target_value_max: null,
    };
  }

  const reps = value.match(/^\s*(\d+)\s*(?:rep(?:s|eticiones?)?)?\s*$/i);
  if (reps) {
    const targetValue = parseTarget(reps[1]);
    if (targetValue == null) return null;
    return {
      measure_type: TrainingMeasureType.REPS,
      target_value: targetValue,
      target_value_min: null,
      target_value_max: null,
    };
  }

  const secondsRange = value.match(
    /^\s*(\d+)\s*-\s*(\d+)\s*(?:s|seg|sec|segundo(?:s)?|second(?:s)?)\s*$/i,
  );
  const repsRange = value.match(
    /^\s*(\d+)\s*-\s*(\d+)\s*(?:rep(?:s|eticiones?)?)?\s*$/i,
  );
  const range = secondsRange ?? repsRange;
  if (range) {
    const min = parseTarget(range[1]);
    const max = parseTarget(range[2]);
    if (min == null || max == null || min > max) return null;
    return {
      measure_type: secondsRange
        ? TrainingMeasureType.SECONDS
        : TrainingMeasureType.REPS,
      target_value: null,
      target_value_min: min,
      target_value_max: max,
    };
  }

  return null;
}

export function resolveExercisePrescription(
  exercise: TrainingPrescriptionInput,
  existing?: ExistingExercisePrescription,
) {
  const hasMeasureType = exercise.measure_type != null;
  const hasTargetValue = exercise.target_value != null;
  const hasTargetMin = exercise.target_value_min != null;
  const hasTargetMax = exercise.target_value_max != null;
  const hasTargetRange = hasTargetMin && hasTargetMax;
  if (
    hasTargetMin !== hasTargetMax ||
    (hasTargetValue && hasTargetRange) ||
    hasMeasureType !== (hasTargetValue || hasTargetRange)
  ) {
    throw new BadRequestException(
      'Indica measure_type y un objetivo exacto o un rango completo',
    );
  }

  const targetRir =
    exercise.target_rir !== undefined
      ? exercise.target_rir
      : (existing?.target_rir ?? null);
  if (hasMeasureType && hasTargetValue) {
    const measureType = exercise.measure_type!;
    const targetValue = exercise.target_value!;
    return {
      reps_or_duration:
        measureType === TrainingMeasureType.SECONDS
          ? `${targetValue}s`
          : `${targetValue}`,
      measure_type: measureType,
      target_value: targetValue,
      target_value_min: null,
      target_value_max: null,
      target_rir: targetRir,
    };
  }

  if (hasMeasureType && hasTargetRange) {
    const measureType = exercise.measure_type!;
    const targetMin = exercise.target_value_min!;
    const targetMax = exercise.target_value_max!;
    if (targetMin > targetMax) {
      throw new BadRequestException(
        'El mínimo del objetivo no puede superar el máximo',
      );
    }
    return {
      reps_or_duration: `${targetMin}-${targetMax}${
        measureType === TrainingMeasureType.SECONDS ? 's' : ''
      }`,
      measure_type: measureType,
      target_value: null,
      target_value_min: targetMin,
      target_value_max: targetMax,
      target_rir: targetRir,
    };
  }

  const legacyValue = exercise.reps_or_duration.trim();
  if (existing && legacyValue === existing.reps_or_duration) {
    return {
      reps_or_duration: existing.reps_or_duration,
      measure_type: existing.measure_type,
      target_value: existing.target_value,
      target_value_min: existing.target_value_min ?? null,
      target_value_max: existing.target_value_max ?? null,
      target_rir: targetRir,
    };
  }

  const parsed = parseLegacyPrescription(legacyValue);
  return {
    reps_or_duration: legacyValue,
    measure_type: parsed?.measure_type ?? null,
    target_value: parsed?.target_value ?? null,
    target_value_min: parsed?.target_value_min ?? null,
    target_value_max: parsed?.target_value_max ?? null,
    target_rir: targetRir,
  };
}
