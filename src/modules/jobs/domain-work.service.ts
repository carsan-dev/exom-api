import { Injectable, OnModuleInit } from '@nestjs/common';
import { DurableWork } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { lockClientDayProgress } from '../../common/progress/day-progress-lock';
import { AchievementsService } from '../achievements/achievements.service';
import { ChallengesService } from '../challenges/challenges.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  JobsService,
  PermanentWorkError,
  RetryWorkError,
} from './jobs.service';
import { APPROVAL_ACTION_LABELS } from '../approval-requests/approval-rules';
import { aggregateScope } from '../../common/progress/aggregate-scope';
import { StreakCalculatorService } from '../streaks/streak-calculator.service';

@Injectable()
export class DomainWorkService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly challenges: ChallengesService,
    private readonly achievements: AchievementsService,
    private readonly notifications: NotificationsService,
    private readonly streakCalculator: StreakCalculatorService = new StreakCalculatorService(
      prisma,
    ),
  ) {}

  onModuleInit() {
    for (const kind of ['APPROVAL_PENDING', 'APPROVAL_RESOLUTION'])
      this.jobs.register(kind, (work) => this.approval(work));
    this.jobs.register('RECONCILE', (work) => this.reconcile(work));
    for (const kind of [
      'STREAK_MILESTONE',
      'ACHIEVEMENT',
      'CHALLENGE_ASSIGNED',
      'CHALLENGE_COMPLETED',
    ]) {
      this.jobs.register(kind, (work) => this.notify(work));
    }
  }

  async approval(work: DurableWork) {
    const payload = work.payload;
    if (
      !payload ||
      typeof payload !== 'object' ||
      Array.isArray(payload) ||
      typeof payload.id !== 'string'
    )
      throw new PermanentWorkError('INVALID_PAYLOAD');
    const request = await this.prisma.approvalRequest.findUnique({
      where: { id: payload.id },
      include: { requester: { include: { profile: true } } },
    });
    if (!request) return;
    const action =
      APPROVAL_ACTION_LABELS[request.action_type] ?? request.action_type;
    if (work.kind === 'APPROVAL_PENDING') {
      if (request.status !== 'PENDING') return;
      const admins = await this.prisma.user.findMany({
        where: { role: 'SUPER_ADMIN', is_active: true },
        select: { id: true },
      });
      const name =
        [
          request.requester.profile?.first_name,
          request.requester.profile?.last_name,
        ]
          .filter(Boolean)
          .join(' ') || request.requester.email;
      await this.notifications.sendInternalNotifications(
        request.requester_id,
        admins.map((a) => a.id),
        'Nueva solicitud de aprobación',
        `${name} solicita ${action}.`,
        { route: '/approval-requests', type: 'approval_pending' },
      );
      return;
    }
    if (request.status === 'APPROVED' && !request.execution_completed_at)
      throw new RetryWorkError('APPROVAL_EXECUTION_UNCONFIRMED');
    if (request.status === 'PENDING')
      throw new RetryWorkError('APPROVAL_UNRESOLVED');
    if (!['APPROVED', 'REJECTED', 'FAILED'].includes(request.status))
      throw new PermanentWorkError('APPROVAL_STATUS_UNSUPPORTED');
    const sender =
      request.reviewer_id ??
      (await this.notifications.findSystemSenderId(request.requester_id));
    if (!sender) throw new RetryWorkError('SYSTEM_SENDER_UNAVAILABLE');
    const rejected = request.status === 'REJECTED',
      failed = request.status === 'FAILED';
    await this.notifications.sendInternalNotifications(
      sender,
      failed ? [request.requester_id, sender] : [request.requester_id],
      rejected
        ? 'Solicitud rechazada'
        : failed
          ? 'Falló la ejecución de la solicitud'
          : 'Solicitud aprobada',
      rejected
        ? `Tu solicitud para ${action} fue rechazada: ${request.rejection_reason}`
        : failed
          ? `La acción aprobada para ${action} no pudo ejecutarse. Revisa la solicitud.`
          : `Tu solicitud para ${action} fue aprobada.`,
      {
        route: '/approval-requests',
        type: rejected
          ? 'approval_rejected'
          : failed
            ? 'approval_failed'
            : 'approval_approved',
      },
    );
  }

  async reconcile(work: DurableWork) {
    if (!work.owner_id) throw new PermanentWorkError('OWNER_REQUIRED');
    const owner = work.owner_id;
    await this.prisma.$transaction(
      async (tx) => {
        // Order matches progress writers; user deletion barrier follows these locks.
        await lockClientDayProgress(tx, owner);
        const users = await tx.$queryRaw<
          { id: string }[]
        >`SELECT id FROM users WHERE id=${owner} FOR KEY SHARE`;
        if (!users.length) return;
        const rules = aggregateScope(work.payload);
        if (!rules || rules.includes('STREAK_DAYS')) {
          await this.streakCalculator.recalculateClient(owner, { db: tx });
        }
        await this.challenges.recalculateAutomaticProgress(
          owner,
          tx,
          undefined,
          rules,
        );
        await this.achievements.evaluateAutomaticAchievementsForUser(
          owner,
          tx,
          undefined,
          rules ? [...rules, 'CHALLENGES_COMPLETED'] : undefined,
        );
        // Grants/transitions create notification intents in this same transaction.
      },
      { maxWait: 5000, timeout: 30000 },
    );
  }

  async notify(work: DurableWork) {
    if (!work.owner_id) throw new PermanentWorkError('OWNER_REQUIRED');
    const payload = work.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
      throw new PermanentWorkError('INVALID_PAYLOAD');
    if (
      !(await this.prisma.user.findUnique({
        where: { id: work.owner_id },
        select: { id: true },
      }))
    )
      return;
    const sender = await this.notifications.findSystemSenderId(work.owner_id);
    if (!sender) throw new Error('SYSTEM_SENDER_UNAVAILABLE');
    if (work.kind === 'STREAK_MILESTONE') {
      if (typeof payload.days !== 'number')
        throw new PermanentWorkError('INVALID_PAYLOAD');
      await this.notifications.sendInternalTemplate(
        sender,
        [work.owner_id],
        'streak_milestone',
        { days: payload.days },
        {
          title: `${payload.days} días de racha!`,
          body: 'Sigue así. Tu constancia está creciendo.',
          route: '/',
        },
        { type: 'streak' },
      );
    } else {
      if (typeof payload.id !== 'string' || typeof payload.name !== 'string')
        throw new PermanentWorkError('INVALID_PAYLOAD');
      if (work.kind === 'ACHIEVEMENT') {
        await this.notifications.sendInternalTemplate(
          sender,
          [work.owner_id],
          'achievement_unlocked',
          { achievementName: payload.name },
          {
            title: 'Logro desbloqueado',
            body: payload.name,
            route: '/achievements',
          },
          { type: 'achievement', achievement_id: payload.id },
        );
      } else {
        const complete = work.kind === 'CHALLENGE_COMPLETED';
        await this.notifications.sendInternalTemplate(
          sender,
          [work.owner_id],
          complete ? 'challenge_completed' : 'challenge_assigned',
          { challengeName: payload.name },
          {
            title: `${complete ? 'Reto completado' : 'Nuevo reto'}: ${payload.name}`,
            body: complete
              ? 'Buen trabajo. Has completado el reto.'
              : 'Tienes un nuevo reto disponible.',
            route: '/challenges',
          },
          { type: 'challenge', challenge_id: payload.id },
        );
      }
    }
  }
}
