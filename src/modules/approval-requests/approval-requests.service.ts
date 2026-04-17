import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ModuleRef } from '@nestjs/core';
import {
  ApprovalStatus,
  Prisma,
  Role,
  type ApprovalRequest,
} from '@prisma/client';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { paginate } from '../../common/dto/pagination.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { AchievementsService } from '../achievements/achievements.service';
import { ChallengesService } from '../challenges/challenges.service';
import { DietsService } from '../diets/diets.service';
import { ExercisesService } from '../exercises/exercises.service';
import { IngredientsService } from '../ingredients/ingredients.service';
import { MealsService } from '../meals/meals.service';
import { NotificationsService } from '../notifications/notifications.service';
import { TrainingsService } from '../trainings/trainings.service';
import {
  APPROVAL_ACTION_LABELS,
  APPROVAL_RULES,
  type ApprovalCheckType,
} from './approval-rules';
import { ApprovalRequestReasonDto } from './dto/approval-request-reason.dto';
import { ApprovalRequestsQueryDto } from './dto/approval-requests-query.dto';
import { MyApprovalRequestsQueryDto } from './dto/my-approval-requests-query.dto';
import { ResolveApprovalRequestDto } from './dto/resolve-approval-request.dto';

const approvalRequestInclude = {
  requester: {
    select: {
      id: true,
      email: true,
      profile: {
        select: {
          first_name: true,
          last_name: true,
          avatar_url: true,
        },
      },
    },
  },
  reviewer: {
    select: {
      id: true,
      email: true,
      profile: {
        select: {
          first_name: true,
          last_name: true,
          avatar_url: true,
        },
      },
    },
  },
} as const satisfies Prisma.ApprovalRequestInclude;

type ApprovalRequestRecord = Prisma.ApprovalRequestGetPayload<{
  include: typeof approvalRequestInclude;
}>;

type ApprovalRequestWhere = Prisma.ApprovalRequestWhereInput;
type ApprovalRequestListQuery =
  | ApprovalRequestsQueryDto
  | MyApprovalRequestsQueryDto;

@Injectable()
export class ApprovalRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly moduleRef: ModuleRef,
    private readonly notificationsService: NotificationsService,
  ) {}

  async requiresApproval(
    user: AuthenticatedUser,
    actionType: string,
    resourceType: string,
    resourceId?: string,
    body?: unknown,
  ): Promise<boolean> {
    if (user.role === Role.SUPER_ADMIN || user.role !== Role.ADMIN) {
      return false;
    }

    const rule = APPROVAL_RULES[actionType];

    if (!rule) {
      return false;
    }

    switch (rule.check) {
      case 'always':
        return true;
      case 'ownership':
        return this.requiresOwnershipApproval(user.id, resourceType, resourceId);
      case 'meal_diet_ownership':
        return this.requiresMealDietApproval(user.id, actionType, resourceId, body);
      case 'challenge_global':
        return this.requiresChallengeGlobalApproval(body);
      case 'challenge_ownership':
        return this.requiresChallengeOwnershipApproval(user.id, resourceId);
      case 'challenge_client_ownership':
        return this.requiresChallengeClientApproval(user.id, body);
      case 'target_client_ownership':
        return this.requiresTargetClientApproval(user.id, body);
      case 'notification_recipient_ownership':
        return this.requiresNotificationRecipientApproval(user.id, body);
      default:
        return false;
    }
  }

  async createRequest(
    requesterId: string,
    actionType: string,
    resourceType: string,
    resourceId: string | undefined,
    payload: unknown,
    requestReason?: string,
  ): Promise<{ approvalRequest: ApprovalRequest; alreadyExists: boolean }> {
    const normalizedPayload = this.normalizePayload(payload);
    const existing = await this.findExistingPendingRequest(
      requesterId,
      actionType,
      resourceId,
    );

    if (existing) {
      return this.mergeExistingPendingRequest(
        existing,
        actionType,
        normalizedPayload,
      );
    }

    try {
      const approvalRequest = await this.prisma.approvalRequest.create({
        data: {
          requester_id: requesterId,
          action_type: actionType,
          resource_type: resourceType,
          resource_id: resourceId ?? null,
          payload: normalizedPayload,
          request_reason: requestReason ?? null,
        },
      });

      await this.notifySuperAdminsOfNewRequest(approvalRequest);

      return { approvalRequest, alreadyExists: false };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const pendingRequest = await this.findExistingPendingRequest(
          requesterId,
          actionType,
          resourceId,
        );

        if (pendingRequest) {
          return this.mergeExistingPendingRequest(
            pendingRequest,
            actionType,
            normalizedPayload,
          );
        }
      }

      throw error;
    }
  }

  async findAll(query: ApprovalRequestsQueryDto) {
    return this.findPaginated(query);
  }

  async findByRequester(requesterId: string, query: MyApprovalRequestsQueryDto) {
    return this.findPaginated(query, requesterId);
  }

  async validateRequestReason(rawRequestReason: unknown) {
    const candidate = Array.isArray(rawRequestReason)
      ? rawRequestReason.find(
          (value): value is string => typeof value === 'string',
        )
      : rawRequestReason;

    if (
      candidate === undefined ||
      candidate === null ||
      candidate === ''
    ) {
      return undefined;
    }

    const dto = plainToInstance(ApprovalRequestReasonDto, {
      request_reason: candidate,
    });
    const errors = await validate(dto);

    if (errors.length === 0) {
      return dto.request_reason;
    }

    const messages = errors.flatMap((error) =>
      error.constraints ? Object.values(error.constraints) : [],
    );

    throw new BadRequestException(
      messages.length > 0
        ? messages
        : 'El motivo de la solicitud no es válido',
    );
  }

  async findOne(id: string, user: Pick<AuthenticatedUser, 'id' | 'role'>) {
    const approvalRequest = await this.prisma.approvalRequest.findUnique({
      where: { id },
      include: approvalRequestInclude,
    });

    if (!approvalRequest) {
      throw new NotFoundException('Solicitud de aprobación no encontrada');
    }

    if (user.role === Role.ADMIN && approvalRequest.requester_id !== user.id) {
      throw new ForbiddenException('No tienes acceso a esta solicitud');
    }

    const currentResource = approvalRequest.resource_id
      ? await this.findCurrentResource(
          approvalRequest.resource_type,
          approvalRequest.resource_id,
        )
      : null;

    const detail = {
      ...approvalRequest,
      current_resource: currentResource,
      resource_deleted: Boolean(
        approvalRequest.resource_id && currentResource === null,
      ),
      resource_name: this.getResourceName(approvalRequest, currentResource),
    };

    if (user.role === Role.ADMIN) {
      const {
        payload: _payload,
        current_resource: _currentResource,
        ...businessDetail
      } = detail;

      return businessDetail;
    }

    return detail;
  }

  async findPendingByResource(resourceType: string, resourceId: string) {
    return this.prisma.approvalRequest.findMany({
      where: {
        resource_type: resourceType,
        resource_id: resourceId,
        status: ApprovalStatus.PENDING,
      },
      include: approvalRequestInclude,
      orderBy: { created_at: 'desc' },
    });
  }

  async findPendingBatchByResource(resourceType: string, resourceIds: string[]) {
    const uniqueResourceIds = [...new Set(resourceIds.filter(Boolean))];

    if (uniqueResourceIds.length === 0) {
      return [];
    }

    const requests = await this.prisma.approvalRequest.findMany({
      where: {
        resource_type: resourceType,
        resource_id: { in: uniqueResourceIds },
        status: ApprovalStatus.PENDING,
      },
      select: {
        resource_id: true,
        action_type: true,
      },
    });

    const grouped = new Map<string, Set<string>>();

    for (const request of requests) {
      if (!request.resource_id) {
        continue;
      }

      if (!grouped.has(request.resource_id)) {
        grouped.set(request.resource_id, new Set());
      }

      grouped.get(request.resource_id)!.add(request.action_type);
    }

    return Array.from(grouped.entries()).map(([resource_id, actionSet]) => ({
      resource_id,
      has_pending_approval: true,
      pending_approval_actions: [...actionSet],
    }));
  }

  async resolve(
    id: string,
    reviewerId: string,
    dto: ResolveApprovalRequestDto,
  ) {
    const approvalRequest = await this.prisma.approvalRequest.findUnique({
      where: { id },
      include: approvalRequestInclude,
    });

    if (!approvalRequest) {
      throw new NotFoundException('Solicitud de aprobación no encontrada');
    }

    const updated = await this.prisma.approvalRequest.updateMany({
      where: { id, status: ApprovalStatus.PENDING },
      data: {
        status:
          dto.action === 'approve'
            ? ApprovalStatus.APPROVED
            : ApprovalStatus.REJECTED,
        reviewer_id: reviewerId,
        resolved_at: new Date(),
        rejection_reason:
          dto.action === 'reject' ? dto.rejection_reason ?? null : null,
        failure_reason: null,
      },
    });

    if (updated.count === 0) {
      throw new ConflictException(
        'La solicitud ya fue resuelta por otro administrador',
      );
    }

    if (dto.action === 'reject') {
      const rejectedRequest = await this.getRequestOrThrow(id);

      await this.notificationsService.sendInternalNotifications(
        reviewerId,
        [approvalRequest.requester_id],
        'Solicitud rechazada',
        `Tu solicitud para ${this.getActionLabel(approvalRequest.action_type)} fue rechazada: ${dto.rejection_reason}`,
        { route: '/approval-requests', type: 'approval_rejected' },
      );

      return rejectedRequest;
    }

    try {
      await this.executeApprovedAction(approvalRequest, reviewerId);

      await this.notificationsService.sendInternalNotifications(
        reviewerId,
        [approvalRequest.requester_id],
        'Solicitud aprobada',
        `Tu solicitud para ${this.getActionLabel(approvalRequest.action_type)} fue aprobada.`,
        { route: '/approval-requests', type: 'approval_approved' },
      );

      return this.getRequestOrThrow(id);
    } catch (error) {
      const failureReason =
        error instanceof Error ? error.message : 'Error inesperado al ejecutar la acción';

      const failedRequest = await this.prisma.approvalRequest.update({
        where: { id },
        data: {
          status: ApprovalStatus.FAILED,
          failure_reason: failureReason,
        },
        include: approvalRequestInclude,
      });

      await this.notificationsService.sendInternalNotifications(
        reviewerId,
        [approvalRequest.requester_id, reviewerId],
        'Falló la ejecución de la solicitud',
        `La acción aprobada para ${this.getActionLabel(approvalRequest.action_type)} no pudo ejecutarse: ${failureReason}`,
        { route: '/approval-requests', type: 'approval_failed' },
      );

      return failedRequest;
    }
  }

  async cancelRequest(id: string, requesterId: string) {
    const approvalRequest = await this.prisma.approvalRequest.findUnique({
      where: { id },
    });

    if (!approvalRequest) {
      throw new NotFoundException('Solicitud de aprobación no encontrada');
    }

    if (approvalRequest.requester_id !== requesterId) {
      throw new ForbiddenException('No puedes cancelar esta solicitud');
    }

    if (approvalRequest.status !== ApprovalStatus.PENDING) {
      throw new ConflictException('Solo puedes cancelar solicitudes pendientes');
    }

    const updated = await this.prisma.approvalRequest.updateMany({
      where: {
        id,
        requester_id: requesterId,
        status: ApprovalStatus.PENDING,
      },
      data: {
        status: ApprovalStatus.REJECTED,
        rejection_reason: 'Solicitud cancelada por el admin solicitante',
        resolved_at: new Date(),
      },
    });

    if (updated.count === 0) {
      throw new ConflictException(
        'La solicitud ya fue resuelta por otro administrador',
      );
    }

    return { message: 'Solicitud cancelada correctamente' };
  }

  async getStats() {
    const [pending, approved, rejected, failed] = await Promise.all([
      this.prisma.approvalRequest.count({
        where: { status: ApprovalStatus.PENDING },
      }),
      this.prisma.approvalRequest.count({
        where: { status: ApprovalStatus.APPROVED },
      }),
      this.prisma.approvalRequest.count({
        where: { status: ApprovalStatus.REJECTED },
      }),
      this.prisma.approvalRequest.count({
        where: { status: ApprovalStatus.FAILED },
      }),
    ]);

    return {
      pending,
      approved,
      rejected,
      failed,
    };
  }

  private buildWhere(
    query: ApprovalRequestListQuery,
    requesterId?: string,
  ): ApprovalRequestWhere {
    return {
      ...(query.status ? { status: query.status } : {}),
      ...(query.resource_type ? { resource_type: query.resource_type } : {}),
      ...(requesterId ? { requester_id: requesterId } : {}),
      ...(!requesterId &&
      'requester_id' in query &&
      query.requester_id
        ? { requester_id: query.requester_id }
        : {}),
    };
  }

  private async findPaginated(
    query: ApprovalRequestListQuery,
    requesterId?: string,
  ) {
    const where = this.buildWhere(query, requesterId);
    const [ids, total] = await Promise.all([
      this.findOrderedRequestIds(query, requesterId),
      this.prisma.approvalRequest.count({ where }),
    ]);

    if (ids.length === 0) {
      return paginate([], total, query);
    }

    const requests = await this.prisma.approvalRequest.findMany({
      where: { id: { in: ids } },
      include: approvalRequestInclude,
    });
    const requestMap = new Map(requests.map((request) => [request.id, request]));
    const data = ids
      .map((id) => requestMap.get(id))
      .filter(
        (request): request is ApprovalRequestRecord => request !== undefined,
      );

    return paginate(data, total, query);
  }

  private async findOrderedRequestIds(
    query: ApprovalRequestListQuery,
    requesterId?: string,
  ) {
    const filters: Prisma.Sql[] = [];

    if (query.status) {
      filters.push(
        Prisma.sql`"status" = CAST(${query.status} AS "ApprovalStatus")`,
      );
    }

    if (query.resource_type) {
      filters.push(Prisma.sql`"resource_type" = ${query.resource_type}`);
    }

    if (requesterId) {
      filters.push(Prisma.sql`"requester_id" = ${requesterId}`);
    } else if ('requester_id' in query && query.requester_id) {
      filters.push(Prisma.sql`"requester_id" = ${query.requester_id}`);
    }

    const whereClause =
      filters.length > 0
        ? Prisma.sql`WHERE ${Prisma.join(filters, ' AND ')}`
        : Prisma.sql``;
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "approval_requests"
      ${whereClause}
      ORDER BY
        CASE WHEN "status" = 'PENDING' THEN 0 ELSE 1 END,
        "created_at" DESC,
        "id" DESC
      OFFSET ${query.skip}
      LIMIT ${query.limit}
    `);

    return rows.map((row) => row.id);
  }

  private async getRequestOrThrow(id: string): Promise<ApprovalRequestRecord> {
    const approvalRequest = await this.prisma.approvalRequest.findUnique({
      where: { id },
      include: approvalRequestInclude,
    });

    if (!approvalRequest) {
      throw new NotFoundException('Solicitud de aprobación no encontrada');
    }

    return approvalRequest;
  }

  private async findExistingPendingRequest(
    requesterId: string,
    actionType: string,
    resourceId?: string,
  ) {
    return this.prisma.approvalRequest.findFirst({
      where: {
        requester_id: requesterId,
        action_type: actionType,
        resource_id: resourceId ?? null,
        status: ApprovalStatus.PENDING,
      },
    });
  }

  private async mergeExistingPendingRequest(
    existing: ApprovalRequest,
    actionType: string,
    payload: Prisma.InputJsonValue,
  ) {
    const mergedPayload = this.mergePendingPayload(
      actionType,
      existing.payload,
      payload,
    );

    if (!mergedPayload) {
      return { approvalRequest: existing, alreadyExists: true };
    }

    const approvalRequest = await this.prisma.approvalRequest.update({
      where: { id: existing.id },
      data: { payload: mergedPayload },
    });

    return { approvalRequest, alreadyExists: true };
  }

  private mergePendingPayload(
    actionType: string,
    currentPayload: unknown,
    nextPayload: unknown,
  ): Prisma.InputJsonValue | null {
    const current = this.getPayloadRecord(currentPayload);
    const next = this.getPayloadRecord(nextPayload);

    if (actionType === 'challenge.assign') {
      return {
        ...current,
        ...next,
        client_ids: this.mergeStringArrays(
          this.getStringArrayField(current, 'client_ids'),
          this.getStringArrayField(next, 'client_ids'),
        ),
        apply_to_all_visible_clients:
          this.getBooleanField(current, 'apply_to_all_visible_clients') === true ||
          this.getBooleanField(next, 'apply_to_all_visible_clients') === true,
      };
    }

    if (actionType === 'achievement.grant') {
      const userIds = this.mergeStringArrays(
        this.getTargetClientIds(current),
        this.getTargetClientIds(next),
      );

      return {
        ...current,
        ...next,
        user_id: userIds[0],
        user_ids: userIds,
      };
    }

    return null;
  }

  private getPayloadRecord(payload: unknown): Record<string, unknown> {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return {};
    }

    return payload as Record<string, unknown>;
  }

  private mergeStringArrays(...groups: string[][]) {
    return [...new Set(groups.flat())];
  }

  private normalizePayload(payload: unknown): Prisma.InputJsonValue {
    const safePayload = payload ?? {};
    return JSON.parse(JSON.stringify(safePayload)) as Prisma.InputJsonValue;
  }

  private getActionLabel(actionType: string) {
    return APPROVAL_ACTION_LABELS[actionType] ?? actionType;
  }

  private getResourceName(
    approvalRequest: ApprovalRequestRecord,
    currentResource: unknown,
  ) {
    const currentName = this.getRecordName(currentResource);

    if (currentName) {
      return currentName;
    }

    const payloadName = this.getRecordName(approvalRequest.payload);

    if (payloadName) {
      return payloadName;
    }

    const targetUserId = this.getStringField(approvalRequest.payload, 'user_id');

    if (targetUserId) {
      return targetUserId;
    }

    const targetUserIds = this.getStringArrayField(approvalRequest.payload, 'user_ids');

    if (targetUserIds.length > 0) {
      return targetUserIds.join(', ');
    }

    return approvalRequest.resource_id ?? 'Sin recurso asociado';
  }

  private getRecordName(record: unknown) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      return undefined;
    }

    const name = (record as Record<string, unknown>).name;

    if (typeof name === 'string' && name.trim().length > 0) {
      return name;
    }

    const title = (record as Record<string, unknown>).title;

    return typeof title === 'string' && title.trim().length > 0
      ? title
      : undefined;
  }

  private getRequesterName(request: ApprovalRequestRecord) {
    const firstName = request.requester.profile?.first_name?.trim();
    const lastName = request.requester.profile?.last_name?.trim();
    const fullName = [firstName, lastName].filter(Boolean).join(' ');

    return fullName || request.requester.email;
  }

  private async notifySuperAdminsOfNewRequest(approvalRequest: ApprovalRequest) {
    const populatedRequest = await this.getRequestOrThrow(approvalRequest.id);
    const superAdmins = await this.prisma.user.findMany({
      where: {
        role: Role.SUPER_ADMIN,
        is_active: true,
      },
      select: { id: true },
    });

    if (superAdmins.length === 0) {
      return;
    }

    await this.notificationsService.sendInternalNotifications(
      approvalRequest.requester_id,
      superAdmins.map((user) => user.id),
      'Nueva solicitud de aprobación',
      `${this.getRequesterName(populatedRequest)} solicita ${this.getActionLabel(approvalRequest.action_type)}.`,
      { route: '/approval-requests', type: 'approval_pending' },
    );
  }

  private async requiresOwnershipApproval(
    userId: string,
    resourceType: string,
    resourceId?: string,
  ) {
    if (!resourceId) {
      return false;
    }

    const ownerId = await this.findResourceOwner(resourceType, resourceId);

    if (ownerId === undefined) {
      return false;
    }

    return ownerId !== userId;
  }

  private async findResourceOwner(resourceType: string, resourceId: string) {
    switch (resourceType) {
      case 'training': {
        const training = await this.prisma.training.findUnique({
          where: { id: resourceId },
          select: { created_by: true },
        });
        return training?.created_by;
      }
      case 'diet': {
        const diet = await this.prisma.diet.findUnique({
          where: { id: resourceId },
          select: { created_by: true },
        });
        return diet?.created_by;
      }
      case 'exercise': {
        const exercise = await this.prisma.exercise.findUnique({
          where: { id: resourceId },
          select: { created_by: true },
        });
        return exercise?.created_by;
      }
      case 'ingredient': {
        const ingredient = await this.prisma.ingredient.findUnique({
          where: { id: resourceId },
          select: { created_by: true },
        });
        return ingredient?.created_by;
      }
      case 'achievement': {
        const achievement = await this.prisma.achievement.findUnique({
          where: { id: resourceId },
          select: { created_by: true },
        });
        return achievement?.created_by;
      }
      default:
        return undefined;
    }
  }

  private async requiresMealDietApproval(
    userId: string,
    actionType: string,
    resourceId: string | undefined,
    body?: unknown,
  ) {
    if (actionType === 'meal.create') {
      const dietId = this.getStringField(body, 'diet_id');

      if (!dietId) {
        return false;
      }

      const diet = await this.prisma.diet.findUnique({
        where: { id: dietId },
        select: { created_by: true },
      });

      if (!diet) {
        return false;
      }

      return diet.created_by !== userId;
    }

    if (!resourceId) {
      return false;
    }

    const meal = await this.prisma.meal.findUnique({
      where: { id: resourceId },
      select: { diet_id: true },
    });

    if (!meal) {
      return false;
    }

    const diet = await this.prisma.diet.findUnique({
      where: { id: meal.diet_id },
      select: { created_by: true },
    });

    if (!diet) {
      return false;
    }

    return diet.created_by !== userId;
  }

  private requiresChallengeGlobalApproval(body?: unknown) {
    return this.getBooleanField(body, 'is_global') === true;
  }

  private async requiresChallengeOwnershipApproval(
    userId: string,
    resourceId?: string,
  ) {
    if (!resourceId) {
      return false;
    }

    const challenge = await this.prisma.challenge.findUnique({
      where: { id: resourceId },
      select: { created_by: true, is_global: true },
    });

    if (!challenge) {
      return false;
    }

    return challenge.is_global || challenge.created_by !== userId;
  }

  private async requiresChallengeClientApproval(
    adminId: string,
    body?: unknown,
  ) {
    if (this.getBooleanField(body, 'apply_to_all_visible_clients') === true) {
      return false;
    }

    const clientIds = this.getStringArrayField(body, 'client_ids');

    if (clientIds.length === 0) {
      return false;
    }

    if (!(await this.areValidClientIds(clientIds))) {
      return false;
    }

    return !(await this.areClientsVisibleToAdmin(adminId, clientIds));
  }

  private async requiresTargetClientApproval(adminId: string, body?: unknown) {
    const userIds = this.getTargetClientIds(body);

    if (userIds.length === 0) {
      return false;
    }

    if (!(await this.areValidClientIds(userIds))) {
      return false;
    }

    return !(await this.areClientsVisibleToAdmin(adminId, userIds));
  }

  private async requiresNotificationRecipientApproval(
    adminId: string,
    body?: unknown,
  ) {
    const recipientIds = this.getNotificationRecipientIds(body);

    if (recipientIds.length === 0) {
      return false;
    }

    if (!(await this.areValidClientIds(recipientIds))) {
      return false;
    }

    return !(await this.areClientsVisibleToAdmin(adminId, recipientIds));
  }

  private getStringField(body: unknown, key: string) {
    if (!body || typeof body !== 'object') {
      return undefined;
    }

    const value = (body as Record<string, unknown>)[key];
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
  }

  private getBooleanField(body: unknown, key: string) {
    if (!body || typeof body !== 'object') {
      return undefined;
    }

    const value = (body as Record<string, unknown>)[key];
    return typeof value === 'boolean' ? value : undefined;
  }

  private getStringArrayField(body: unknown, key: string) {
    if (!body || typeof body !== 'object') {
      return [];
    }

    const value = (body as Record<string, unknown>)[key];

    if (!Array.isArray(value)) {
      return [];
    }

    return [...new Set(value.filter((item): item is string => typeof item === 'string'))];
  }

  private getNotificationRecipientIds(body: unknown) {
    const userId = this.getStringField(body, 'user_id');

    if (userId) {
      return [userId];
    }

    return this.getStringArrayField(body, 'user_ids');
  }

  private getTargetClientIds(body: unknown) {
    const userId = this.getStringField(body, 'user_id');

    return this.mergeStringArrays(
      userId ? [userId] : [],
      this.getStringArrayField(body, 'user_ids'),
    );
  }

  private async areValidClientIds(clientIds: string[]) {
    const uniqueClientIds = [...new Set(clientIds)];
    const clients = await this.prisma.user.findMany({
      where: {
        id: { in: uniqueClientIds },
        role: Role.CLIENT,
      },
      select: { id: true },
    });

    return clients.length === uniqueClientIds.length;
  }

  private async isValidClientId(clientId: string) {
    return this.areValidClientIds([clientId]);
  }

  private async areClientsVisibleToAdmin(adminId: string, clientIds: string[]) {
    const uniqueClientIds = [...new Set(clientIds)];
    const assignments = await this.prisma.adminClientAssignment.findMany({
      where: {
        admin_id: adminId,
        is_active: true,
        client_id: { in: uniqueClientIds },
      },
      select: { client_id: true },
    });

    return assignments.length === uniqueClientIds.length;
  }

  private async findCurrentResource(resourceType: string, resourceId: string) {
    switch (resourceType) {
      case 'training':
        return this.prisma.training.findUnique({
          where: { id: resourceId },
          include: {
            exercises: {
              orderBy: { order: 'asc' },
              include: { exercise: true },
            },
          },
        });
      case 'diet':
        return this.prisma.diet.findUnique({
          where: { id: resourceId },
          include: {
            meals: {
              orderBy: { order: 'asc' },
              include: {
                ingredients: {
                  include: { ingredient: true },
                },
              },
            },
          },
        });
      case 'exercise':
        return this.prisma.exercise.findUnique({ where: { id: resourceId } });
      case 'ingredient':
        return this.prisma.ingredient.findUnique({ where: { id: resourceId } });
      case 'meal':
        return this.prisma.meal.findUnique({
          where: { id: resourceId },
          include: {
            ingredients: {
              include: { ingredient: true },
            },
          },
        });
      case 'challenge':
        return this.prisma.challenge.findUnique({ where: { id: resourceId } });
      case 'achievement':
        return this.prisma.achievement.findUnique({ where: { id: resourceId } });
      case 'notification':
        return this.prisma.notification.findUnique({ where: { id: resourceId } });
      default:
        return null;
    }
  }

  private getService<T>(token: new (...args: never[]) => T) {
    return this.moduleRef.get(token, { strict: false });
  }

  private async executeApprovedAction(
    approvalRequest: ApprovalRequestRecord,
    reviewerId: string,
  ) {
    const payload = approvalRequest.payload as Record<string, unknown>;

    switch (approvalRequest.action_type) {
      case 'training.update':
        return this.getService(TrainingsService).update(
          approvalRequest.resource_id!,
          payload,
        );
      case 'training.delete':
        return this.getService(TrainingsService).remove(approvalRequest.resource_id!);
      case 'diet.update':
        return this.getService(DietsService).update(
          approvalRequest.resource_id!,
          payload,
        );
      case 'diet.delete':
        return this.getService(DietsService).remove(approvalRequest.resource_id!);
      case 'exercise.update':
        return this.getService(ExercisesService).update(
          approvalRequest.resource_id!,
          payload,
        );
      case 'exercise.delete':
        return this.getService(ExercisesService).remove(approvalRequest.resource_id!);
      case 'ingredient.update':
        return this.getService(IngredientsService).update(
          approvalRequest.resource_id!,
          payload,
        );
      case 'ingredient.delete':
        return this.getService(IngredientsService).remove(
          approvalRequest.resource_id!,
        );
      case 'meal.create':
        return this.getService(MealsService).createFromApproval(
          payload as unknown as Parameters<MealsService['createFromBody']>[0],
        );
      case 'meal.update':
        return this.getService(MealsService).updateFromApproval(
          approvalRequest.resource_id!,
          payload as unknown as Parameters<MealsService['updateFromDto']>[1],
        );
      case 'meal.delete':
        return this.getService(MealsService).removeFromApproval(
          approvalRequest.resource_id!,
        );
      case 'challenge.create':
        return this.getService(ChallengesService).create(
          reviewerId,
          Role.SUPER_ADMIN,
          payload as unknown as Parameters<ChallengesService['create']>[2],
        );
      case 'challenge.update':
        return this.getService(ChallengesService).update(
          approvalRequest.resource_id!,
          reviewerId,
          Role.SUPER_ADMIN,
          payload as unknown as Parameters<ChallengesService['update']>[3],
        );
      case 'challenge.delete':
        return this.getService(ChallengesService).remove(
          approvalRequest.resource_id!,
          reviewerId,
          Role.SUPER_ADMIN,
        );
      case 'challenge.assign':
        return this.getService(ChallengesService).assignToClients(
          approvalRequest.resource_id!,
          reviewerId,
          Role.SUPER_ADMIN,
          payload as unknown as Parameters<ChallengesService['assignToClients']>[3],
        );
      case 'achievement.create':
        return this.getService(AchievementsService).create(
          payload as unknown as Parameters<AchievementsService['create']>[0],
          {
          id: reviewerId,
          role: Role.SUPER_ADMIN,
          },
        );
      case 'achievement.update':
        return this.getService(AchievementsService).update(
          approvalRequest.resource_id!,
          payload as unknown as Parameters<AchievementsService['update']>[1],
          { id: reviewerId, role: Role.SUPER_ADMIN },
        );
      case 'achievement.grant':
        return this.getService(AchievementsService).grantToUser(
          approvalRequest.resource_id!,
          payload as unknown as Parameters<AchievementsService['grantToUser']>[1],
          { id: reviewerId, role: Role.SUPER_ADMIN },
        );
      case 'achievement.revoke':
        return this.getService(AchievementsService).revokeFromUser(
          approvalRequest.resource_id!,
          payload as unknown as Parameters<AchievementsService['revokeFromUser']>[1],
          { id: reviewerId, role: Role.SUPER_ADMIN },
        );
      case 'achievement.recompute':
        return this.getService(AchievementsService).recomputeAchievements(
          payload as unknown as Parameters<AchievementsService['recomputeAchievements']>[0],
          {
            id: reviewerId,
            role: Role.SUPER_ADMIN,
          },
        );
      case 'notification.send': {
        const notificationsService = this.getService(NotificationsService);
        const title = this.getStringField(payload, 'title');
        const body = this.getStringField(payload, 'body');

        if (!title || !body) {
          throw new BadRequestException('La notificación aprobada no tiene contenido válido');
        }

        const data =
          payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
            ? (payload.data as Record<string, string>)
            : undefined;
        const singleRecipientId = this.getStringField(payload, 'user_id');

        if (singleRecipientId) {
          return notificationsService.sendToUser(
            reviewerId,
            singleRecipientId,
            title,
            body,
            data,
          );
        }

        const recipientIds = this.getStringArrayField(payload, 'user_ids');

        return notificationsService.sendToMultiple(
          reviewerId,
          recipientIds,
          title,
          body,
          data,
        );
      }
      default:
        throw new BadRequestException(
          `No existe un ejecutor para la acción ${approvalRequest.action_type}`,
        );
    }
  }
}
