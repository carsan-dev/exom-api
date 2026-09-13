import { BadRequestException } from '@nestjs/common';

export type TimeUnit = 'SECONDS' | 'MINUTES';
export type TimedSegment = { action: string; seconds: number; unit: TimeUnit };
export type TimedConfig = {
  version: 1;
  unit: TimeUnit;
  segments: TimedSegment[];
};
const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const isUnit = (v: unknown): v is TimeUnit =>
  v === 'SECONDS' || v === 'MINUTES';

/** Seconds are canonical; the config contains presentation and ordered actions only. */
export function validateTimedConfig(value: unknown): TimedConfig {
  const invalid = () =>
    new BadRequestException('Prescripción temporal inválida');
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !isUnit(value.unit) ||
    !Array.isArray(value.segments) ||
    value.segments.length > 20 ||
    Object.keys(value).some((k) => !['version', 'unit', 'segments'].includes(k))
  )
    throw invalid();
  const segments = value.segments.map((s: unknown) => {
    if (
      !isRecord(s) ||
      typeof s.action !== 'string' ||
      !s.action.trim() ||
      s.action.trim().length > 80 ||
      typeof s.seconds !== 'number' ||
      !Number.isInteger(s.seconds) ||
      s.seconds < 1 ||
      s.seconds > 2147483647 ||
      !isUnit(s.unit) ||
      Object.keys(s).some((k) => !['action', 'seconds', 'unit'].includes(k))
    )
      throw invalid();
    return { action: s.action.trim(), seconds: s.seconds, unit: s.unit };
  });
  return { version: 1, unit: value.unit, segments };
}

export function formatTime(seconds: number, unit: TimeUnit): string {
  // Non-terminating minute decimals use min+s instead of rounding canonical seconds.
  if (unit === 'SECONDS') return `${seconds} s`;
  if (seconds % 3 === 0) return `${seconds / 60} min`;
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

export function timedInstructions(total: number, config: TimedConfig): string {
  const base = `${formatTime(total, config.unit)} en total.`;
  if (!config.segments.length) return base;
  const sequence = config.segments
    .map((s) => `${s.action}: ${formatTime(s.seconds, s.unit)}`)
    .join('; ');
  const cycle = config.segments.reduce((sum, s) => sum + s.seconds, 0);
  let tail = total % cycle;
  let ending = '';
  for (const s of config.segments) {
    if (tail > 0 && tail < s.seconds) {
      ending = ` Último tramo recortado: ${s.action}, ${formatTime(tail, s.unit)}.`;
      break;
    }
    tail -= s.seconds;
    if (tail <= 0) break;
  }
  return `${base} ${sequence}; repetir hasta terminar.${ending}`;
}

export function resolveTimedPrescription(
  input: { timed_config?: unknown },
  prescription: {
    measure_type: string | null;
    target_value: number | null;
    target_value_min: number | null;
    target_value_max: number | null;
    reps_or_duration: string;
  },
  existing?: { timed_config?: unknown },
) {
  const raw =
    input.timed_config === undefined
      ? existing?.timed_config
      : input.timed_config;
  if (raw == null) return null;
  const config = validateTimedConfig(raw);
  if (
    prescription.measure_type !== 'SECONDS' ||
    (config.segments.length > 0 && prescription.target_value == null)
  ) {
    throw new BadRequestException(
      'Los intervalos necesitan un total exacto en segundos; elimina explícitamente la configuración para cambiar a repeticiones',
    );
  }
  return config;
}
