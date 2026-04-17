import { ConflictException } from '@nestjs/common';
import { ApprovalStatus, Role } from '@prisma/client';
import { ModuleRef } from '@nestjs/core';
import { PrismaService } from '../../prisma/prisma.service';
import { MealsService } from '../meals/meals.service';
import { NotificationsService } from '../notifications/notifications.service';
import { TrainingsService } from '../trainings/trainings.service';
import { ApprovalRequestsService } from './approval-requests.service';
import { ApprovalRequestsQueryDto } from './dto/approval-requests-query.dto';

function createApprovalRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: 'approval-1',
    requester_id: 'admin-1',
    reviewer_id: null,
    action_type: 'training.delete',
    resource_type: 'training',
    resource_id: 'training-1',
    payload: {},
    request_reason: null,
    status: ApprovalStatus.PENDING,
    rejection_reason: null,
    failure_reason: null,
    resolved_at: null,
    created_at: new Date('2026-04-05T10:00:00.000Z'),
    updated_at: new Date('2026-04-05T10:00:00.000Z'),
    requester: {
      id: 'admin-1',
      email: 'admin@exom.dev',
      profile: {
        first_name: 'Ada',
        last_name: 'Admin',
        avatar_url: null,
      },
    },
    reviewer: null,
    ...overrides,
  };
}

describe('ApprovalRequestsService', () => {
  let service: ApprovalRequestsService;
  let prisma: {
    training: { findUnique: jest.Mock };
    approvalRequest: {
      findFirst: jest.Mock;
      create: jest.Mock;
      findUnique: jest.Mock;
      findMany: jest.Mock;
      updateMany: jest.Mock;
      update: jest.Mock;
      count: jest.Mock;
    };
    $queryRaw: jest.Mock;
    user: { findMany: jest.Mock };
    adminClientAssignment: { findMany: jest.Mock };
  };
  let moduleRef: { get: jest.Mock };
  let notificationsService: { sendInternalNotifications: jest.Mock };

  const adminUser = {
    id: 'admin-1',
    email: 'admin@exom.dev',
    role: Role.ADMIN,
    firebase_uid: 'firebase-admin-1',
  };

  beforeEach(() => {
    prisma = {
      training: { findUnique: jest.fn() },
      approvalRequest: {
        findFirst: jest.fn(),
        create: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        updateMany: jest.fn(),
        update: jest.fn(),
        count: jest.fn(),
      },
      $queryRaw: jest.fn(),
      user: { findMany: jest.fn() },
      adminClientAssignment: { findMany: jest.fn() },
    };

    moduleRef = { get: jest.fn() };
    notificationsService = { sendInternalNotifications: jest.fn() };

    service = new ApprovalRequestsService(
      prisma as unknown as PrismaService,
      moduleRef as unknown as ModuleRef,
      notificationsService as unknown as NotificationsService,
    );
  });

  it('requires approval when updating a training owned by another admin', async () => {
    prisma.training.findUnique.mockResolvedValue({ created_by: 'admin-2' });

    await expect(
      service.requiresApproval(adminUser, 'training.update', 'training', 'training-1'),
    ).resolves.toBe(true);
  });

  it('does not require approval for super admins', async () => {
    await expect(
      service.requiresApproval(
        { ...adminUser, role: Role.SUPER_ADMIN },
        'training.delete',
        'training',
        'training-1',
      ),
    ).resolves.toBe(false);

    expect(prisma.training.findUnique).not.toHaveBeenCalled();
  });

  it('returns the existing pending request instead of creating a duplicate', async () => {
    const existingRequest = createApprovalRequest({ requester: undefined, reviewer: undefined });
    prisma.approvalRequest.findFirst.mockResolvedValue(existingRequest);

    await expect(
      service.createRequest('admin-1', 'training.delete', 'training', 'training-1', {}),
    ).resolves.toEqual({
      approvalRequest: existingRequest,
      alreadyExists: true,
    });

    expect(prisma.approvalRequest.create).not.toHaveBeenCalled();
    expect(notificationsService.sendInternalNotifications).not.toHaveBeenCalled();
  });

  it('merges assign targets into an existing pending challenge request', async () => {
    const existingRequest = createApprovalRequest({
      action_type: 'challenge.assign',
      resource_type: 'challenge',
      resource_id: 'challenge-1',
      payload: {
        client_ids: ['client-1'],
        apply_to_all_visible_clients: false,
      },
      requester: undefined,
      reviewer: undefined,
    });
    const updatedRequest = {
      ...existingRequest,
      payload: {
        client_ids: ['client-1', 'client-2'],
        apply_to_all_visible_clients: false,
      },
    };

    prisma.approvalRequest.findFirst.mockResolvedValue(existingRequest);
    prisma.approvalRequest.update.mockResolvedValue(updatedRequest);

    await expect(
      service.createRequest(
        'admin-1',
        'challenge.assign',
        'challenge',
        'challenge-1',
        { client_ids: ['client-2'], apply_to_all_visible_clients: false },
      ),
    ).resolves.toEqual({
      approvalRequest: updatedRequest,
      alreadyExists: true,
    });

    expect(prisma.approvalRequest.update).toHaveBeenCalledWith({
      where: { id: 'approval-1' },
      data: {
        payload: {
          client_ids: ['client-1', 'client-2'],
          apply_to_all_visible_clients: false,
        },
      },
    });
    expect(prisma.approvalRequest.create).not.toHaveBeenCalled();
  });

  it('merges grant targets into an existing pending achievement request', async () => {
    const existingRequest = createApprovalRequest({
      action_type: 'achievement.grant',
      resource_type: 'achievement',
      resource_id: 'ach-1',
      payload: { user_id: 'client-1' },
      requester: undefined,
      reviewer: undefined,
    });
    const updatedRequest = {
      ...existingRequest,
      payload: {
        user_id: 'client-1',
        user_ids: ['client-1', 'client-2'],
      },
    };

    prisma.approvalRequest.findFirst.mockResolvedValue(existingRequest);
    prisma.approvalRequest.update.mockResolvedValue(updatedRequest);

    await expect(
      service.createRequest(
        'admin-1',
        'achievement.grant',
        'achievement',
        'ach-1',
        { user_ids: ['client-2'] },
      ),
    ).resolves.toEqual({
      approvalRequest: updatedRequest,
      alreadyExists: true,
    });

    expect(prisma.approvalRequest.update).toHaveBeenCalledWith({
      where: { id: 'approval-1' },
      data: {
        payload: {
          user_id: 'client-1',
          user_ids: ['client-1', 'client-2'],
        },
      },
    });
    expect(prisma.approvalRequest.create).not.toHaveBeenCalled();
  });

  it('requires approval when any bulk achievement grant target is outside admin visibility', async () => {
    prisma.user.findMany.mockResolvedValue([
      { id: 'client-1' },
      { id: 'client-2' },
    ]);
    prisma.adminClientAssignment.findMany.mockResolvedValue([
      { client_id: 'client-1' },
    ]);

    await expect(
      service.requiresApproval(
        adminUser,
        'achievement.grant',
        'achievement',
        'ach-1',
        { user_ids: ['client-1', 'client-2'] },
      ),
    ).resolves.toBe(true);
  });

  it('returns the existing pending request when resource_id is null', async () => {
    const existingRequest = createApprovalRequest({
      action_type: 'meal.create',
      resource_type: 'meal',
      resource_id: null,
      payload: { diet_id: 'diet-1', name: 'Nueva comida' },
      requester: undefined,
      reviewer: undefined,
    });
    prisma.approvalRequest.findFirst.mockResolvedValue(existingRequest);

    await expect(
      service.createRequest(
        'admin-1',
        'meal.create',
        'meal',
        undefined,
        { diet_id: 'diet-1', name: 'Nueva comida' },
      ),
    ).resolves.toEqual({
      approvalRequest: existingRequest,
      alreadyExists: true,
    });

    expect(prisma.approvalRequest.findFirst).toHaveBeenCalledWith({
      where: {
        requester_id: 'admin-1',
        action_type: 'meal.create',
        resource_id: null,
        status: ApprovalStatus.PENDING,
      },
    });
    expect(prisma.approvalRequest.create).not.toHaveBeenCalled();
  });

  it('creates a new request and notifies active super admins', async () => {
    const createdRequest = createApprovalRequest({ requester: undefined, reviewer: undefined });

    prisma.approvalRequest.findFirst.mockResolvedValue(null);
    prisma.approvalRequest.create.mockResolvedValue(createdRequest);
    prisma.approvalRequest.findUnique.mockResolvedValue(createApprovalRequest());
    prisma.user.findMany.mockResolvedValue([{ id: 'super-1' }, { id: 'super-2' }]);

    await expect(
      service.createRequest(
        'admin-1',
        'training.delete',
        'training',
        'training-1',
        { foo: 'bar' },
        'Necesito corregir un contenido que pertenece a otra cartera',
      ),
    ).resolves.toEqual({
      approvalRequest: createdRequest,
      alreadyExists: false,
    });

    expect(prisma.approvalRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          requester_id: 'admin-1',
          action_type: 'training.delete',
          resource_type: 'training',
          resource_id: 'training-1',
          payload: { foo: 'bar' },
          request_reason: 'Necesito corregir un contenido que pertenece a otra cartera',
        }),
      }),
    );
    expect(notificationsService.sendInternalNotifications).toHaveBeenCalledWith(
      'admin-1',
      ['super-1', 'super-2'],
      'Nueva solicitud de aprobación',
      expect.any(String),
      { route: '/approval-requests', type: 'approval_pending' },
    );
  });

  it('returns a business-safe detail for admins', async () => {
    prisma.approvalRequest.findUnique.mockResolvedValue(createApprovalRequest({
      payload: { name: 'Entrenamiento ajustado', notes: 'solo visible en payload tecnico' },
    }));
    prisma.training.findUnique.mockResolvedValue({
      id: 'training-1',
      name: 'Entrenamiento base',
    });

    const detail = await service.findOne('approval-1', { id: 'admin-1', role: Role.ADMIN });

    expect(detail).toEqual(
      expect.objectContaining({
        id: 'approval-1',
        resource_name: 'Entrenamiento base',
        resource_deleted: false,
      }),
    );
    expect(detail).not.toHaveProperty('payload');
    expect(detail).not.toHaveProperty('current_resource');
  });

  it('keeps the technical detail for super admins', async () => {
    prisma.approvalRequest.findUnique.mockResolvedValue(createApprovalRequest({
      payload: { name: 'Entrenamiento ajustado' },
    }));
    prisma.training.findUnique.mockResolvedValue({
      id: 'training-1',
      name: 'Entrenamiento base',
      exercises: [],
    });

    await expect(
      service.findOne('approval-1', { id: 'super-1', role: Role.SUPER_ADMIN }),
    ).resolves.toEqual(
      expect.objectContaining({
        id: 'approval-1',
        payload: { name: 'Entrenamiento ajustado' },
        current_resource: {
          id: 'training-1',
          name: 'Entrenamiento base',
          exercises: [],
        },
        resource_name: 'Entrenamiento base',
      }),
    );
  });

  it('approves and executes the original action', async () => {
    const approvedRequest = createApprovalRequest({
      status: ApprovalStatus.APPROVED,
      reviewer_id: 'super-1',
    });
    const trainingsService = {
      remove: jest.fn().mockResolvedValue(undefined),
    };

    prisma.approvalRequest.findUnique
      .mockResolvedValueOnce(createApprovalRequest())
      .mockResolvedValueOnce(approvedRequest);
    prisma.approvalRequest.updateMany.mockResolvedValue({ count: 1 });
    moduleRef.get.mockImplementation((token) =>
      token === TrainingsService ? trainingsService : undefined,
    );

    await expect(
      service.resolve('approval-1', 'super-1', { action: 'approve' }),
    ).resolves.toEqual(approvedRequest);

    expect(trainingsService.remove).toHaveBeenCalledWith('training-1');
    expect(notificationsService.sendInternalNotifications).toHaveBeenCalledWith(
      'super-1',
      ['admin-1'],
      'Solicitud aprobada',
      'Tu solicitud para eliminar entrenamiento fue aprobada.',
      { route: '/approval-requests', type: 'approval_approved' },
    );
  });

  it('orders approval requests with pending first before pagination', async () => {
    const query = Object.assign(new ApprovalRequestsQueryDto(), {
      page: 1,
      limit: 2,
    });

    prisma.$queryRaw.mockResolvedValue([
      { id: 'approval-2' },
      { id: 'approval-1' },
    ]);
    prisma.approvalRequest.count.mockResolvedValue(2);
    prisma.approvalRequest.findMany.mockResolvedValue([
      createApprovalRequest({
        id: 'approval-1',
        status: ApprovalStatus.APPROVED,
      }),
      createApprovalRequest({
        id: 'approval-2',
        status: ApprovalStatus.PENDING,
      }),
    ]);

    await expect(service.findAll(query)).resolves.toMatchObject({
      data: [
        expect.objectContaining({ id: 'approval-2' }),
        expect.objectContaining({ id: 'approval-1' }),
      ],
      total: 2,
      page: 1,
      limit: 2,
      totalPages: 1,
    });

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('trims and validates the request reason before persisting it', async () => {
    await expect(
      service.validateRequestReason('   Necesito revisar este cambio con detalle   '),
    ).resolves.toBe('Necesito revisar este cambio con detalle');

    await expect(service.validateRequestReason('corta')).rejects.toThrow();
  });

  it('rejects a request and notifies the requester', async () => {
    const rejectedRequest = createApprovalRequest({
      status: ApprovalStatus.REJECTED,
      reviewer_id: 'super-1',
      rejection_reason: 'No cumple con la política interna',
    });

    prisma.approvalRequest.findUnique
      .mockResolvedValueOnce(createApprovalRequest())
      .mockResolvedValueOnce(rejectedRequest);
    prisma.approvalRequest.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      service.resolve('approval-1', 'super-1', {
        action: 'reject',
        rejection_reason: 'No cumple con la política interna',
      }),
    ).resolves.toEqual(rejectedRequest);

    expect(notificationsService.sendInternalNotifications).toHaveBeenCalledWith(
      'super-1',
      ['admin-1'],
      'Solicitud rechazada',
      'Tu solicitud para eliminar entrenamiento fue rechazada: No cumple con la política interna',
      { route: '/approval-requests', type: 'approval_rejected' },
    );
  });

  it('prevents concurrent resolutions with an atomic update', async () => {
    prisma.approvalRequest.findUnique.mockResolvedValue(createApprovalRequest());
    prisma.approvalRequest.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.resolve('approval-1', 'super-1', { action: 'approve' }),
    ).rejects.toThrow(
      new ConflictException('La solicitud ya fue resuelta por otro administrador'),
    );
  });

  it('marks the request as failed when approved execution throws', async () => {
    const failedRequest = createApprovalRequest({
      status: ApprovalStatus.FAILED,
      reviewer_id: 'super-1',
      failure_reason: 'Training not found',
    });
    const trainingsService = {
      remove: jest.fn().mockRejectedValue(new Error('Training not found')),
    };

    prisma.approvalRequest.findUnique.mockResolvedValue(createApprovalRequest());
    prisma.approvalRequest.updateMany.mockResolvedValue({ count: 1 });
    prisma.approvalRequest.update.mockResolvedValue(failedRequest);
    moduleRef.get.mockImplementation((token) =>
      token === TrainingsService ? trainingsService : undefined,
    );

    await expect(
      service.resolve('approval-1', 'super-1', { action: 'approve' }),
    ).resolves.toEqual(failedRequest);

    expect(prisma.approvalRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'approval-1' },
        data: {
          status: ApprovalStatus.FAILED,
          failure_reason: 'Training not found',
        },
      }),
    );
    expect(notificationsService.sendInternalNotifications).toHaveBeenCalledWith(
      'super-1',
      ['admin-1', 'super-1'],
      'Falló la ejecución de la solicitud',
      'La acción aprobada para eliminar entrenamiento no pudo ejecutarse: Training not found',
      { route: '/approval-requests', type: 'approval_failed' },
    );
  });

  it.each([
    {
      actionType: 'meal.create',
      resourceId: null,
      payload: { diet_id: 'diet-1', name: 'Nueva comida', ingredients: [] },
      methodName: 'createFromApproval',
      expectedArgs: [{ diet_id: 'diet-1', name: 'Nueva comida', ingredients: [] }],
    },
    {
      actionType: 'meal.update',
      resourceId: 'meal-1',
      payload: { name: 'Comida ajustada' },
      methodName: 'updateFromApproval',
      expectedArgs: ['meal-1', { name: 'Comida ajustada' }],
    },
    {
      actionType: 'meal.delete',
      resourceId: 'meal-1',
      payload: {},
      methodName: 'removeFromApproval',
      expectedArgs: ['meal-1'],
    },
  ])(
    'executes %s through the meal approval path without ownership checks',
    async ({ actionType, resourceId, payload, methodName, expectedArgs }) => {
      const approvedRequest = createApprovalRequest({
        action_type: actionType,
        resource_type: 'meal',
        resource_id: resourceId,
        payload,
      });
      const resolvedRequest = createApprovalRequest({
        action_type: actionType,
        resource_type: 'meal',
        resource_id: resourceId,
        payload,
        status: ApprovalStatus.APPROVED,
        reviewer_id: 'super-1',
      });
      const mealsService = {
        createFromApproval: jest.fn().mockResolvedValue(undefined),
        updateFromApproval: jest.fn().mockResolvedValue(undefined),
        removeFromApproval: jest.fn().mockResolvedValue(undefined),
      };

      prisma.approvalRequest.findUnique
        .mockResolvedValueOnce(approvedRequest)
        .mockResolvedValueOnce(resolvedRequest);
      prisma.approvalRequest.updateMany.mockResolvedValue({ count: 1 });
      moduleRef.get.mockImplementation((token) =>
        token === MealsService ? mealsService : undefined,
      );

      await expect(
        service.resolve('approval-1', 'super-1', { action: 'approve' }),
      ).resolves.toEqual(resolvedRequest);

      expect(mealsService[methodName as keyof typeof mealsService]).toHaveBeenCalledWith(
        ...expectedArgs,
      );
    },
  );
});
