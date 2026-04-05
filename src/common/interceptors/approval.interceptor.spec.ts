import { HttpStatus } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { ApprovalRequestsService } from '../../modules/approval-requests/approval-requests.service';
import { ApprovalInterceptor } from './approval.interceptor';
import { TransformInterceptor } from './transform.interceptor';

describe('ApprovalInterceptor', () => {
  const reflector = {
    getAllAndOverride: jest.fn(),
  };

  const approvalRequestsService = {
    requiresApproval: jest.fn(),
    validateRequestReason: jest.fn(),
    createRequest: jest.fn(),
  };

  const interceptor = new ApprovalInterceptor(
    reflector as never,
    approvalRequestsService as unknown as ApprovalRequestsService,
  );

  const transformInterceptor = new TransformInterceptor();

  beforeEach(() => {
    jest.clearAllMocks();
    approvalRequestsService.validateRequestReason.mockResolvedValue(undefined)
  });

  function createContext() {
    const request = {
      user: {
        id: 'admin-1',
        email: 'admin@exom.dev',
        role: 'ADMIN',
        firebase_uid: 'firebase-admin-1',
      },
      params: { id: 'training-1' },
      body: { name: 'Nuevo nombre' },
      headers: {} as Record<string, string>,
    };
    const response = {
      status: jest.fn().mockReturnThis(),
    };

    return {
      request,
      response,
      context: {
        getHandler: jest.fn(),
        getClass: jest.fn(),
        switchToHttp: () => ({
          getRequest: () => request,
          getResponse: () => response,
        }),
      },
    };
  }

  it('passes through when the route does not require approval metadata', async () => {
    const { context } = createContext();
    const next = {
      handle: jest.fn().mockReturnValue(of({ ok: true })),
    };

    reflector.getAllAndOverride.mockReturnValue(undefined);

    await expect(
      lastValueFrom(interceptor.intercept(context as never, next)),
    ).resolves.toEqual({ ok: true });

    expect(approvalRequestsService.requiresApproval).not.toHaveBeenCalled();
    expect(next.handle).toHaveBeenCalledTimes(1);
  });

  it('passes through when the approval service says the action is free', async () => {
    const { context, request } = createContext();
    const next = {
      handle: jest.fn().mockReturnValue(of({ ok: true })),
    };

    reflector.getAllAndOverride.mockReturnValue({
      actionType: 'training.update',
      resourceType: 'training',
    });
    approvalRequestsService.requiresApproval.mockResolvedValue(false);

    await expect(
      lastValueFrom(interceptor.intercept(context as never, next)),
    ).resolves.toEqual({ ok: true });

    expect(approvalRequestsService.requiresApproval).toHaveBeenCalledWith(
      request.user,
      'training.update',
      'training',
      'training-1',
      { name: 'Nuevo nombre' },
    );
    expect(next.handle).toHaveBeenCalledTimes(1);
  });

  it('short-circuits the handler and returns a 202 payload when approval is required', async () => {
    const { context, response } = createContext();
    const next = {
      handle: jest.fn().mockReturnValue(of({ ok: true })),
    };

    reflector.getAllAndOverride.mockReturnValue({
      actionType: 'training.update',
      resourceType: 'training',
    });
    approvalRequestsService.requiresApproval.mockResolvedValue(true);
    approvalRequestsService.createRequest.mockResolvedValue({
      approvalRequest: { id: 'approval-1' },
      alreadyExists: false,
    });

    await expect(
      lastValueFrom(interceptor.intercept(context as never, next)),
    ).resolves.toEqual({
      message: 'Solicitud enviada para aprobación',
      approval_request_id: 'approval-1',
      already_exists: false,
    });

    expect(next.handle).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(HttpStatus.ACCEPTED);
  });

  it('passes the validated request reason into the approval request creation', async () => {
    const { context, request } = createContext();
    const next = {
      handle: jest.fn().mockReturnValue(of({ ok: true })),
    };

    request.headers['x-approval-request-reason'] = '   Necesito coordinacion con el super admin   '

    reflector.getAllAndOverride.mockReturnValue({
      actionType: 'training.update',
      resourceType: 'training',
    });
    approvalRequestsService.requiresApproval.mockResolvedValue(true);
    approvalRequestsService.validateRequestReason.mockResolvedValue('Necesito coordinacion con el super admin');
    approvalRequestsService.createRequest.mockResolvedValue({
      approvalRequest: { id: 'approval-3' },
      alreadyExists: false,
    });

    await expect(
      lastValueFrom(interceptor.intercept(context as never, next)),
    ).resolves.toEqual({
      message: 'Solicitud enviada para aprobación',
      approval_request_id: 'approval-3',
      already_exists: false,
    });

    expect(approvalRequestsService.validateRequestReason).toHaveBeenCalledWith(
      '   Necesito coordinacion con el super admin   ',
    );
    expect(approvalRequestsService.createRequest).toHaveBeenCalledWith(
      request.user.id,
      'training.update',
      'training',
      'training-1',
      { name: 'Nuevo nombre' },
      'Necesito coordinacion con el super admin',
    );
  });

  it('remains compatible with the transform interceptor wrapper', async () => {
    const { context } = createContext();
    const next = {
      handle: jest.fn().mockReturnValue(of({ ok: true })),
    };

    reflector.getAllAndOverride.mockReturnValue({
      actionType: 'training.delete',
      resourceType: 'training',
    });
    approvalRequestsService.requiresApproval.mockResolvedValue(true);
    approvalRequestsService.createRequest.mockResolvedValue({
      approvalRequest: { id: 'approval-2' },
      alreadyExists: true,
    });

    const transformed = transformInterceptor.intercept(context as never, {
      handle: () => interceptor.intercept(context as never, next),
    });

    await expect(lastValueFrom(transformed)).resolves.toEqual(
      expect.objectContaining({
        success: true,
        data: {
          message: 'Solicitud enviada para aprobación',
          approval_request_id: 'approval-2',
          already_exists: true,
        },
        timestamp: expect.any(String),
      }),
    );
  });
});
