import type { SchemaObject } from '@nestjs/swagger';

export const rirSequenceSchema: SchemaObject = {
  type: 'array',
  minItems: 1,
  items: { type: 'integer', minimum: 0, maximum: 10 },
};
export const rirOverrideSchema: SchemaObject = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['mode'],
      properties: { mode: { type: 'string', enum: ['INHERIT', 'NONE'] } },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['mode', 'value'],
      properties: {
        mode: { type: 'string', enum: ['FIXED'] },
        value: { type: 'integer', minimum: 0, maximum: 10 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['mode', 'sequence'],
      properties: {
        mode: { type: 'string', enum: ['SEQUENCE'] },
        sequence: rirSequenceSchema,
      },
    },
  ],
};
export const rirConfigSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['sequence', 'overrides'],
  properties: {
    sequence: rirSequenceSchema,
    overrides: { type: 'object', additionalProperties: rirOverrideSchema },
  },
  description:
    'Cada excepción SEQUENCE debe tener la longitud de sequence; los IDs deben pertenecer a ocurrencias válidas. El servicio valida estas relaciones.',
};
export const timedConfigSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['version', 'unit', 'segments'],
  properties: {
    version: { type: 'integer', enum: [1] },
    unit: { type: 'string', enum: ['SECONDS', 'MINUTES'] },
    segments: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'seconds', 'unit'],
        properties: {
          action: {
            type: 'string',
            pattern: '^\\s*\\S(?:[\\s\\S]{0,78}\\S)?\\s*$',
            description:
              'Entre 1 y 80 caracteres después de trim; se devuelve recortado.',
          },
          seconds: { type: 'integer', minimum: 1, maximum: 2147483647 },
          unit: { type: 'string', enum: ['SECONDS', 'MINUTES'] },
        },
      },
    },
  },
  description:
    'Omitido conserva, null elimina. action se recorta antes de validar longitud. Solo con measure_type=SECONDS; tramos no vacíos requieren target_value exacto. Secuencia repetida y recortada al total; no altera descanso ni tiempo realizado.',
};
