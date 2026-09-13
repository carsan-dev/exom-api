import { type INestApplication, RequestMethod } from '@nestjs/common';
import type { Type } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { SchemaObject, ReferenceObject } from '@nestjs/swagger';
import contracts from './contracts/response-contracts.json';
import { REQUIRES_APPROVAL_KEY } from './common/decorators/requires-approval.decorator';
import { IS_PUBLIC_KEY } from './common/decorators/public.decorator';
import { describeRequestValidation } from './contracts/request-metadata';

type Schema = SchemaObject | ReferenceObject;
const envelope = (data: Schema, optional = false): SchemaObject => ({
  type: 'object',
  required: optional
    ? ['success', 'timestamp']
    : ['success', 'data', 'timestamp'],
  properties: {
    success: { type: 'boolean', enum: [true] },
    data,
    timestamp: { type: 'string', format: 'date-time' },
  },
});
export const httpErrorSchema: SchemaObject = {
  type: 'object',
  required: ['statusCode', 'message', 'error', 'timestamp', 'path'],
  properties: {
    statusCode: { type: 'integer', minimum: 400, maximum: 599 },
    message: {
      anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
    },
    error: { type: 'string' },
    code: { type: 'string' },
    operation_id: { type: 'string', format: 'uuid' },
    current_revision: { type: 'integer', minimum: 0 },
    current_progress: {},
    timestamp: { type: 'string', format: 'date-time' },
    path: { type: 'string' },
  },
};

/** The same document is served locally and checked in CI. */
export function createOpenApiDocument(app: INestApplication) {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('EXOM API')
      .setDescription(
        'API REST para la plataforma EXOM de entrenamiento personal y nutrición',
      )
      .setVersion('1.0.0')
      .addBearerAuth({
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Firebase Auth JWT',
      })
      .build(),
  );
  // The JSON contains only descriptive schemas. It is not executable validation.
  const responseContracts: {
    operations: Record<
      string,
      {
        schema: Schema;
        dataOptional: boolean;
        parameters: Array<{ name: string; in: string; required: boolean }>;
      }
    >;
    schemas: Record<string, Schema>;
  } = contracts;
  Object.assign(document.components!.schemas!, responseContracts.schemas, {
    HttpError: httpErrorSchema,
  });
  const handlers = new Map<
    string,
    { status: number; approval: boolean; isPublic: boolean }
  >();
  const parameterDtos = new Set<Type<unknown>>();
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype;
      if (!controller) continue;
      const prototype = controller.prototype as Record<string, unknown>;
      for (const methodName of Object.getOwnPropertyNames(prototype)) {
        const handler = prototype[methodName];
        if (typeof handler !== 'function') continue;
        const method: unknown = Reflect.getMetadata(METHOD_METADATA, handler);
        if (method === undefined) continue;
        const parameterTypes: unknown = Reflect.getMetadata(
          'design:paramtypes',
          prototype,
          methodName,
        );
        if (Array.isArray(parameterTypes))
          for (const parameter of parameterTypes) {
            const dto: unknown = parameter;
            if (isConstructor(dto)) parameterDtos.add(dto);
          }
        const code: unknown = Reflect.getMetadata(HTTP_CODE_METADATA, handler);
        handlers.set(`${controller.name}_${methodName}`, {
          status:
            typeof code === 'number'
              ? code
              : method === RequestMethod.POST
                ? 201
                : 200,
          approval: !!Reflect.getMetadata(REQUIRES_APPROVAL_KEY, handler),
          isPublic: !!(
            Reflect.getMetadata(IS_PUBLIC_KEY, handler) ??
            Reflect.getMetadata(IS_PUBLIC_KEY, controller)
          ),
        });
      }
    }
  }
  for (const item of Object.values(document.paths)) {
    for (const method of [
      'get',
      'post',
      'put',
      'patch',
      'delete',
      'head',
      'options',
    ] as const) {
      const operation = item[method];
      if (!operation) continue;
      const id = operation.operationId!;
      const handler = handlers.get(id);
      const contract = responseContracts.operations[id];
      if (!handler || !contract)
        throw new Error(`Missing HTTP contract: ${id}`);
      for (const parameter of contract.parameters) {
        if (
          parameter.in !== 'query' &&
          parameter.in !== 'path' &&
          parameter.in !== 'header'
        )
          throw new Error('Unsupported parameter location');
        operation.parameters ??= [];
        const existing = operation.parameters.find(
          (p) =>
            !('$ref' in p) &&
            p.name === parameter.name &&
            p.in === parameter.in,
        );
        if (existing && !('$ref' in existing)) {
          if (!parameter.required) existing.required = false;
        } else
          operation.parameters.push({
            name: parameter.name,
            in: parameter.in,
            required: parameter.required,
            schema: { type: 'string' },
          });
      }
      for (const status of Object.keys(operation.responses)) {
        if (+status >= 200 && +status < 300) delete operation.responses[status];
      }
      operation.responses[String(handler.status)] =
        handler.status === 204
          ? { description: 'Sin contenido' }
          : {
              description: 'Respuesta HTTP serializada',
              content: {
                'application/json': {
                  schema: envelope(contract.schema, contract.dataOptional),
                },
              },
            };
      if (handler.approval)
        operation.responses['202'] = {
          description: 'Solicitud de aprobación; no confirma la mutación',
          content: {
            'application/json': {
              schema: envelope({
                type: 'object',
                required: ['message', 'approval_request_id', 'already_exists'],
                properties: {
                  message: { type: 'string' },
                  approval_request_id: { type: 'string' },
                  already_exists: { type: 'boolean' },
                },
              }),
            },
          },
        };
      for (const status of Object.keys(operation.responses).filter(
        (s) => +s >= 400,
      )) {
        const previous = operation.responses[status];
        operation.responses[status] = {
          description:
            previous && 'description' in previous
              ? previous.description
              : 'Error HTTP',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/HttpError' },
            },
          },
        };
      }
      operation.responses.default = {
        description:
          'Rechazo de validación/autorización, conflicto o fallo temporal; se conserva el código HTTP real y el recibo público cuando aplica.',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/HttpError' },
          },
        },
      };
      operation.security = handler.isPublic ? [] : [{ bearer: [] }];
    }
  }
  describeRequestValidation(document, [...parameterDtos]);
  return document;
}

function isConstructor(value: unknown): value is Type<unknown> {
  return typeof value === 'function';
}
