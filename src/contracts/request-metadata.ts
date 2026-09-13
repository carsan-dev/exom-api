import type { OpenAPIObject, SchemaObject } from '@nestjs/swagger';
import { getMetadataStorage } from 'class-validator';
import { requestDtos } from './request-dtos';
import type { Type } from '@nestjs/common';

/** Describe the existing ValidationPipe; this never changes its behavior. */
export function describeRequestValidation(
  document: OpenAPIObject,
  parameterDtos: Type<unknown>[] = [],
): void {
  for (const dto of new Set([...requestDtos, ...parameterDtos])) {
    const schema = document.components?.schemas?.[dto.name];
    if (!schema || '$ref' in schema) continue;
    const metadata = getMetadataStorage().getTargetValidationMetadatas(
      dto,
      '',
      false,
      false,
    );
    if (!metadata.length) continue;
    const properties = schema.properties ?? {};
    for (const entry of metadata) {
      // @ApiHideProperty marks this virtual, cross-field validator only.
      if (
        dto.name === 'SendNotificationDto' &&
        entry.propertyName === 'recipient_target'
      )
        continue;
      const property = properties[entry.propertyName];
      if (!property)
        throw new Error(
          `Undocumented DTO property: ${dto.name}.${entry.propertyName}`,
        );
      if ('$ref' in property) continue;
      let target: SchemaObject = property;
      if (entry.each && property.items && !('$ref' in property.items))
        target = property.items;
      const constraint: unknown = entry.constraints?.[0];
      switch (entry.name) {
        case 'isString':
          target.type = 'string';
          break;
        case 'isNotEmpty':
          if (
            metadata.some(
              (item) =>
                item.propertyName === entry.propertyName &&
                item.name === 'isString',
            )
          )
            target.minLength = Math.max(target.minLength ?? 0, 1);
          break;
        case 'isBoolean':
          target.type = 'boolean';
          break;
        case 'isNumber':
          target.type = 'number';
          break;
        case 'isArray':
          property.type = 'array';
          break;
        case 'isObject':
          target.type = 'object';
          break;
        case 'isOptional':
          break;
        case 'arrayNotEmpty':
          property.minItems = Math.max(property.minItems ?? 0, 1);
          break;
        case 'arrayUnique':
          property.uniqueItems = true;
          break;
        case 'isInt':
          target.type = 'integer';
          break;
        case 'min':
          if (typeof constraint === 'number') target.minimum = constraint;
          break;
        case 'max':
          if (typeof constraint === 'number') target.maximum = constraint;
          break;
        case 'minLength':
          if (typeof constraint === 'number') target.minLength = constraint;
          break;
        case 'maxLength':
          if (typeof constraint === 'number') target.maxLength = constraint;
          break;
        case 'arrayMinSize':
          if (typeof constraint === 'number') property.minItems = constraint;
          break;
        case 'arrayMaxSize':
          if (typeof constraint === 'number') property.maxItems = constraint;
          break;
        case 'isIn':
          if (Array.isArray(constraint)) target.enum = constraint;
          break;
      }
    }
    // IsOptional skips both undefined and null. A nullable sibling of $ref or
    // enum is not enough in OpenAPI 3.0; represent the two alternatives explicitly.
    for (const entry of metadata.filter((item) => item.name === 'isOptional')) {
      const property = properties[entry.propertyName];
      if (!property) continue;
      properties[entry.propertyName] = {
        anyOf: [property, { enum: [null], nullable: true }],
      };
      schema.required = schema.required?.filter(
        (name) => name !== entry.propertyName,
      );
    }
    schema.additionalProperties = false;
    if (dto.name === 'SendNotificationDto')
      schema.oneOf = [
        {
          required: ['user_id'],
          properties: {
            user_id: { type: 'string', minLength: 1 },
            user_ids: { enum: [null], nullable: true },
          },
        },
        {
          required: ['user_ids'],
          properties: {
            user_ids: { type: 'array', minItems: 1, items: { type: 'string' } },
            user_id: { enum: [null], nullable: true },
          },
        },
      ];
    if (dto.name === 'CreateTrainingDto')
      schema.anyOf = [
        {
          required: ['type'],
          properties: { type: { type: 'string', minLength: 1 } },
        },
        {
          required: ['types'],
          properties: {
            types: {
              type: 'array',
              minItems: 1,
              items: { type: 'string', minLength: 1 },
            },
          },
        },
      ];
  }
}
