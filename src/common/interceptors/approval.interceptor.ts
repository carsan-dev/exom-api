import {
  CallHandler,
  ExecutionContext,
  HttpStatus,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { from, Observable } from 'rxjs';
import { map, switchMap } from 'rxjs/operators';
import type { AuthenticatedUser } from '../decorators/current-user.decorator';
import {
  REQUIRES_APPROVAL_KEY,
  type ApprovalMetadata,
} from '../decorators/requires-approval.decorator';
import { ApprovalRequestsService } from '../../modules/approval-requests/approval-requests.service';

@Injectable()
export class ApprovalInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly approvalRequestsService: ApprovalRequestsService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const metadata = this.reflector.getAllAndOverride<ApprovalMetadata>(
      REQUIRES_APPROVAL_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!metadata) {
      return next.handle();
    }

    const http = context.switchToHttp();
    const request = http.getRequest<{
      user?: AuthenticatedUser;
      params?: Record<string, string>;
      body?: unknown;
      headers?: Record<string, string | string[] | undefined>;
    }>();
    const response = http.getResponse<Response>();
    const user = request.user;

    if (!user) {
      return next.handle();
    }

    const resourceId = request.params?.id;
    const payload = request.body;

    return from(
      this.approvalRequestsService.requiresApproval(
        user,
        metadata.actionType,
        metadata.resourceType,
        resourceId,
        payload,
      ),
    ).pipe(
      switchMap((requiresApproval) => {
        if (!requiresApproval) {
          return next.handle();
        }

        return from(
          this.approvalRequestsService.validateRequestReason(
            request.headers?.['x-approval-request-reason'],
          ),
        ).pipe(
          switchMap((requestReason) =>
            from(
              this.approvalRequestsService.createRequest(
                user.id,
                metadata.actionType,
                metadata.resourceType,
                resourceId,
                payload,
                requestReason,
              ),
            ).pipe(
              map(({ approvalRequest, alreadyExists }) => {
                response.status(HttpStatus.ACCEPTED);

                return {
                  message: 'Solicitud enviada para aprobación',
                  approval_request_id: approvalRequest.id,
                  already_exists: alreadyExists,
                };
              }),
            ),
          ),
        );
      }),
    );
  }
}
