import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Error interno del servidor';
    let error = 'Internal Server Error';
    let code: string | undefined;
    let recoveryReceipt: { operation_id: string } | undefined;
    let progressConflict:
      | { current_revision: number; current_progress: unknown }
      | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      if (typeof res === 'string') {
        message = res;
      } else if (typeof res === 'object' && res !== null) {
        message = (res as any).message || message;
        error = (res as any).error || error;
        code = (res as any).code;
        // Forward only explicitly public contracts, never arbitrary internals.
        const detail = res as Record<string, unknown>;
        if (
          (code === 'IDENTITY_RECOVERY_PENDING' ||
            code === 'ACCOUNT_DELETION_PENDING') &&
          typeof detail.operation_id === 'string' &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            detail.operation_id,
          )
        ) {
          recoveryReceipt = { operation_id: detail.operation_id };
        }
        if (
          code === 'PROGRESS_VERSION_CONFLICT' &&
          typeof detail.current_revision === 'number' &&
          Number.isSafeInteger(detail.current_revision) &&
          detail.current_revision >= 0 &&
          'current_progress' in detail
        ) {
          progressConflict = {
            current_revision: detail.current_revision,
            current_progress: detail.current_progress,
          };
        }
      }
      if (error === 'Internal Server Error') error = exception.name;
    } else if (exception instanceof Error) {
      this.logger.error(exception.message, exception.stack);
    }

    response.status(status).json({
      statusCode: status,
      message,
      error,
      ...(code && { code }),
      ...recoveryReceipt,
      ...progressConflict,
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }
}
