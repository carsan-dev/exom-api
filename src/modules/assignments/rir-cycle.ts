import { BadRequestException } from '@nestjs/common';

export type RirOverride =
  | { mode: 'INHERIT' }
  | { mode: 'NONE' }
  | { mode: 'FIXED'; value: number }
  | { mode: 'SEQUENCE'; sequence: number[] };
export interface RirConfig {
  sequence: number[];
  overrides: Record<string, RirOverride>;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isRir = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= 10;

export function validateRirSequence(value: unknown): number[] {
  if (!Array.isArray(value) || !value.length || !value.every(isRir)) {
    throw new BadRequestException(
      'La secuencia necesita una o más semanas con RIR entero entre 0 y 10',
    );
  }
  return value;
}

export function validateRirOverride(
  value: unknown,
  length?: number,
): RirOverride {
  if (!isObject(value)) throw new BadRequestException('Excepción RIR inválida');
  const keys = Object.keys(value).sort().join(',');
  if ((value.mode === 'INHERIT' || value.mode === 'NONE') && keys === 'mode')
    return { mode: value.mode };
  if (value.mode === 'FIXED' && keys === 'mode,value' && isRir(value.value))
    return { mode: 'FIXED', value: value.value };
  if (value.mode === 'SEQUENCE' && keys === 'mode,sequence') {
    const sequence = validateRirSequence(value.sequence);
    if (length !== undefined && sequence.length !== length)
      throw new BadRequestException(
        'Las excepciones deben tener la misma duración que la secuencia común',
      );
    return { mode: 'SEQUENCE', sequence };
  }
  throw new BadRequestException('Excepción RIR inválida');
}

export function validateRirConfig(value: unknown): RirConfig {
  if (
    !isObject(value) ||
    Object.keys(value).sort().join(',') !== 'overrides,sequence' ||
    !isObject(value.overrides)
  )
    throw new BadRequestException('Configuración RIR inválida');
  const sequence = validateRirSequence(value.sequence);
  const overrides: Record<string, RirOverride> = {};
  for (const [id, rule] of Object.entries(value.overrides)) {
    if (!id || ['__proto__', 'constructor', 'prototype'].includes(id))
      throw new BadRequestException('Ocurrencia de ejercicio inválida');
    overrides[id] = validateRirOverride(rule, sequence.length);
  }
  return { sequence, overrides };
}

export function monday(date: Date): Date {
  const result = new Date(date);
  result.setUTCHours(0, 0, 0, 0);
  result.setUTCDate(result.getUTCDate() - ((result.getUTCDay() + 6) % 7));
  return result;
}

export function rirWeek(
  date: Date,
  start: Date,
  length: number,
): number | null {
  const weeks = (monday(date).getTime() - monday(start).getTime()) / 604800000;
  return weeks < 0 ? null : weeks % length;
}

export function resolveRir(
  config: RirConfig | null,
  start: Date,
  date: Date,
  id: string,
  base: number | null,
): number | null {
  if (!config) return base;
  const week = rirWeek(date, start, config.sequence.length);
  if (week === null) return base;
  const rule = config.overrides[id];
  if (rule?.mode === 'NONE') return null;
  if (rule?.mode === 'FIXED') return rule.value;
  return (rule?.mode === 'SEQUENCE' ? rule.sequence : config.sequence)[week];
}
