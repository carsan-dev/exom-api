import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { BaseServiceError } from './base-service.error';
import { BaseSourceNotConfiguredError } from './base-pdf-source.provider';

/**
 * Error body `{ statusCode, message, error, code }`: AllExceptionsFilter
 * forwards `code`, so the Admin can branch on it; `message` is Spanish text.
 */
type ExceptionClass = new (body: Record<string, unknown>) => HttpException;

function fail(
  Exception: ExceptionClass,
  statusCode: number,
  error: string,
  code: string,
  message: string,
): HttpException {
  return new Exception({ statusCode, message, error, code });
}

export const baseHttp = {
  badRequest: (code: string, message: string) =>
    fail(BadRequestException, 400, 'Bad Request', code, message),
  forbidden: (code: string, message: string) =>
    fail(ForbiddenException, 403, 'Forbidden', code, message),
  notFound: (code: string, message: string) =>
    fail(NotFoundException, 404, 'Not Found', code, message),
  conflict: (code: string, message: string) =>
    fail(ConflictException, 409, 'Conflict', code, message),
  unavailable: (code: string, message: string) =>
    fail(
      ServiceUnavailableException,
      503,
      'Service Unavailable',
      code,
      message,
    ),
};

/** Where the catalogue was consulted: it changes INVALID_GOAL/DAYS status. */
export type CatalogueContext = 'subscriber' | 'delivery';

/**
 * Maps catalogue/source failures to HTTP. Unknown errors (network, R2) become
 * 503 SOURCE_UNAVAILABLE without echoing provider text.
 */
export function mapSourceError(
  error: unknown,
  context: CatalogueContext,
): HttpException {
  if (error instanceof HttpException) return error;
  if (error instanceof BaseSourceNotConfiguredError)
    return baseHttp.unavailable(
      'SOURCE_NOT_CONFIGURED',
      'El servicio base no tiene configurado el origen de los PDF.',
    );
  if (error instanceof BaseServiceError) {
    switch (error.code) {
      case 'INVALID_NAME':
      case 'INVALID_EMAIL':
      case 'INVALID_ORDER_CODE':
      case 'INVALID_MONTH':
        return baseHttp.badRequest(error.code, error.message);
      case 'INVALID_GOAL':
      case 'INVALID_DAYS':
      case 'STAMP_TOO_LONG':
        return context === 'subscriber'
          ? baseHttp.badRequest(error.code, error.message)
          : baseHttp.conflict(error.code, error.message);
      case 'NO_CONTENT_FOR_MONTH':
        return baseHttp.conflict(error.code, error.message);
      case 'EMPTY_CATALOG':
      case 'AMBIGUOUS_CONTENT':
      case 'MISSING_START_GUIDE':
      case 'SOURCE_NOT_FOUND':
      case 'INVALID_SOURCE_KEY':
        return baseHttp.unavailable(
          error.code,
          `El catálogo de PDF no está completo: ${error.message}`,
        );
    }
  }
  return baseHttp.unavailable(
    'SOURCE_UNAVAILABLE',
    'No se pudo leer el catálogo de PDF. Inténtalo de nuevo en unos minutos.',
  );
}
