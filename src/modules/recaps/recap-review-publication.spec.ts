import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role, RecapStatus } from '@prisma/client';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import type { PoolClient } from 'pg';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { assertTestDatabase } from '../../../scripts/test-database.cjs';
import { RecapsController } from './recaps.controller';
import { RecapsService } from './recaps.service';

type AuthenticatedRequest = Request & { user?: AuthenticatedUser };

const suite = process.env.FOLLOWUP_HTTP_PG === '1' ? describe : describe.skip;
suite('REST-T3B review publication HTTP and coordinated PostgreSQL', () => {
  let app: INestApplication<Server>;
  let prisma: PrismaService;
  let clientId: string;
  let adminId: string;
  let recapId: string;
  let actorId: string;
  let actorRole: Role;
  const sendToUser = jest.fn();
  const draftPath = () => `/recaps/${recapId}/review-draft`;
  const publishPath = () => `/recaps/${recapId}/review-publish`;
  const originalReview = new Date('2026-01-15T12:34:56.789Z');
  beforeEach(async () => {
    prisma = new PrismaService();
    await assertTestDatabase(prisma.postgresqlPool);
    clientId = randomUUID();
    adminId = randomUUID();
    actorId = adminId;
    actorRole = Role.ADMIN;
    await prisma.user.createMany({
      data: [
        { id: clientId, role: Role.CLIENT },
        { id: adminId, role: Role.ADMIN },
      ].map((user) => ({
        ...user,
        firebase_uid: user.id,
        email: `${user.id}@example.test`,
      })),
    });
    await prisma.adminClientAssignment.create({
      data: { admin_id: adminId, client_id: clientId },
    });
    const recap = await prisma.weeklyRecap.create({
      data: {
        client_id: clientId,
        week_start_date: new Date('2026-01-05'),
        week_end_date: new Date('2026-01-11'),
        status: RecapStatus.SUBMITTED,
        submitted_at: new Date('2026-01-12'),
        admin_comments: '  private legacy ñ\r\n  ',
        client_feedback_text: 'Legacy visible feedback',
        client_feedback_sent_at: originalReview,
        client_feedback_read_at: originalReview,
        draft_coach_summary: 'Initial draft',
        draft_changes: 'Initial changes',
        draft_next_week_goals: 'Initial goals',
        published_coach_summary: 'Previous publication',
        published_changes: 'Previous changes',
        published_next_week_goals: 'Previous goals',
      },
    });
    recapId = recap.id;
    const module = await Test.createTestingModule({
      controllers: [RecapsController],
      providers: [
        RecapsService,
        { provide: PrismaService, useValue: prisma },
        { provide: NotificationsService, useValue: { sendToUser } },
      ],
    }).compile();
    app = module.createNestApplication<INestApplication<Server>>();
    app.use((req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
      req.user = {
        id: actorId,
        role: actorRole,
        email: 'synthetic@example.test',
        firebase_uid: actorId,
      };
      next();
    });
    app.useGlobalGuards(new RolesGuard(new Reflector()));
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await app?.close(); // Retain database fixtures and containers.
    sendToUser.mockClear();
  });
  const stored = () =>
    prisma.weeklyRecap.findUniqueOrThrow({ where: { id: recapId } });
  const save = (body: object) =>
    request(app.getHttpServer()).put(draftPath()).send(body);
  const publish = (body: object) =>
    request(app.getHttpServer()).post(publishPath()).send(body);

  it('saves an omitted-preserving draft, publishes only on confirmation, preserves legacy metadata and exposes only publication', async () => {
    const before = await stored();
    const draft = await save({
      expected_version: 0,
      coach_summary: '  New summary ñ\n  ',
      changes: null,
    }).expect(200);
    expect(draft.body as unknown).toMatchObject({
      review_version: 1,
      draft_coach_summary: 'New summary ñ',
      draft_changes: null,
      draft_next_week_goals: 'Initial goals',
      published_coach_summary: 'Previous publication',
      status: RecapStatus.SUBMITTED,
    });
    const unchanged = await stored();
    expect(unchanged.client_feedback_sent_at).toEqual(
      before.client_feedback_sent_at,
    );
    expect(unchanged.reviewed_at).toBeNull();
    actorId = clientId;
    actorRole = Role.CLIENT;
    const previous = await request(app.getHttpServer())
      .get(`/recaps/my/${recapId}`)
      .expect(200);
    expect(previous.body as unknown).toMatchObject({
      published_coach_summary: 'Previous publication',
    });
    expect(previous.body as unknown).not.toHaveProperty('draft_coach_summary');
    actorId = adminId;
    actorRole = Role.ADMIN;
    const first = await publish({ expected_version: 1, confirm: true }).expect(
      200,
    );
    expect(first.body as unknown).toMatchObject({
      review_version: 2,
      published_coach_summary: 'New summary ñ',
      published_changes: null,
      published_next_week_goals: 'Initial goals',
      status: RecapStatus.REVIEWED,
    });
    const confirmed = await stored();
    expect(confirmed.reviewed_at).toBeInstanceOf(Date);
    await save({
      expected_version: 2,
      coach_summary: 'Next private draft',
    }).expect(200);
    actorId = clientId;
    actorRole = Role.CLIENT;
    const detail = await request(app.getHttpServer())
      .get(`/recaps/my/${recapId}`)
      .expect(200);
    expect(detail.body as unknown).toMatchObject({
      published_coach_summary: 'New summary ñ',
      published_changes: null,
      published_next_week_goals: 'Initial goals',
      client_feedback_text: before.client_feedback_text,
    });
    for (const field of [
      'admin_comments',
      'review_version',
      'draft_coach_summary',
      'draft_changes',
      'draft_next_week_goals',
    ])
      expect(detail.body as unknown).not.toHaveProperty(field);
    actorId = adminId;
    actorRole = Role.ADMIN;
    await publish({ expected_version: 3, confirm: true }).expect(200);
    await publish({ expected_version: 3, confirm: true }).expect(409);
    const after = await stored();
    expect(after.review_version).toBe(4);
    expect(after.reviewed_at).toEqual(confirmed.reviewed_at);
    for (const field of [
      'admin_comments',
      'client_feedback_text',
      'client_feedback_sent_at',
      'client_feedback_read_at',
      'submitted_at',
    ] as const)
      expect(after[field]).toEqual(before[field]);
    expect(sendToUser).not.toHaveBeenCalled();
  });

  it('uses explicit null/blank to clear while omitted fields survive and version conflicts do not merge', async () => {
    await save({ expected_version: 0, changes: '   ' }).expect(200);
    await save({ expected_version: 0, next_week_goals: 'stale' }).expect(409);
    expect(await stored()).toMatchObject({
      review_version: 1,
      draft_changes: null,
      draft_next_week_goals: 'Initial goals',
      published_changes: 'Previous changes',
    });
  });

  it('can explicitly confirm cleared fields without inventing a historical publication', async () => {
    await save({
      expected_version: 0,
      coach_summary: null,
      changes: null,
      next_week_goals: null,
    }).expect(200);
    await publish({ expected_version: 1, confirm: true }).expect(200);
    expect(await stored()).toMatchObject({
      review_version: 2,
      published_coach_summary: null,
      published_changes: null,
      published_next_week_goals: null,
    });
  });

  it.each([
    {},
    { expected_version: 0 },
    { expected_version: null, changes: 'x' },
    { expected_version: '0', changes: 'x' },
    { expected_version: -1, changes: 'x' },
    { expected_version: 0.5, changes: 'x' },
    { expected_version: 2147483647, changes: 'x' },
    { expected_version: 0, changes: 42 },
    { expected_version: 0, changes: 'x'.repeat(3001) },
    { expected_version: 0, admin_comments: 'private' },
    { expected_version: 0, published_coach_summary: 'fake' },
  ])(
    'rejects invalid/empty/privileged draft payload %# without writes',
    async (body) => {
      await save(body).expect(400);
      expect((await stored()).review_version).toBe(0);
    },
  );
  it.each([
    {},
    { expected_version: 0 },
    { expected_version: 0, confirm: false },
    { expected_version: 0, confirm: 'true' },
    { expected_version: 0, confirm: null },
    { expected_version: '0', confirm: true },
    { expected_version: 0, confirm: true, coach_summary: 'not persisted' },
  ])(
    'rejects invalid/unconfirmed publication %# without writes',
    async (body) => {
      await publish(body).expect(400);
      expect((await stored()).review_version).toBe(0);
    },
  );
  it.each(['DRAFT', 'unsubmitted', 'archived'])(
    'rejects the %s recap for save and publish',
    async (state) => {
      await prisma.weeklyRecap.update({
        where: { id: recapId },
        data:
          state === 'DRAFT'
            ? { status: RecapStatus.DRAFT }
            : state === 'unsubmitted'
              ? { submitted_at: null }
              : { archived_at: new Date() },
      });
      await save({ expected_version: 0, changes: 'x' }).expect(403);
      await publish({ expected_version: 0, confirm: true }).expect(403);
    },
  );
  it.each([
    'unassigned',
    'inactive',
    'locked',
    'archived',
    'pending',
    'role-changed',
  ])('rejects persisted staff scope %s', async (state) => {
    if (state === 'unassigned')
      await prisma.adminClientAssignment.updateMany({
        where: { admin_id: adminId },
        data: { is_active: false },
      });
    else
      await prisma.user.update({
        where: { id: adminId },
        data:
          state === 'inactive'
            ? { is_active: false }
            : state === 'locked'
              ? { is_locked: true }
              : state === 'archived'
                ? { is_archived: true }
                : state === 'pending'
                  ? { identity_pending: true }
                  : { role: Role.CLIENT },
      });
    await save({ expected_version: 0, changes: 'x' }).expect(403);
    await publish({ expected_version: 0, confirm: true }).expect(403);
  });
  it('denies clients and preserves global eligible SUPER_ADMIN scope', async () => {
    actorRole = Role.CLIENT;
    actorId = clientId;
    await save({ expected_version: 0, changes: 'x' }).expect(403);
    await publish({ expected_version: 0, confirm: true }).expect(403);
    actorRole = Role.SUPER_ADMIN;
    actorId = adminId;
    await prisma.user.update({
      where: { id: adminId },
      data: { role: Role.SUPER_ADMIN },
    });
    await prisma.adminClientAssignment.updateMany({
      where: { admin_id: adminId },
      data: { is_active: false },
    });
    await save({ expected_version: 0, changes: 'global' }).expect(200);
  });

  async function waitBlocked(fragment: string): Promise<void> {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const { rows } = await prisma.postgresqlPool.query<{ pid: number }>(
        `SELECT pid FROM pg_stat_activity WHERE datname=current_database()
         AND wait_event_type='Lock' AND position($1 in query)>0
         AND cardinality(pg_blocking_pids(pid))>0`,
        [fragment],
      );
      if (rows.length) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(
      `Required PostgreSQL blocking edge not observed: ${fragment}`,
    );
  }
  async function holder(): Promise<PoolClient> {
    const connection = await prisma.postgresqlPool.connect();
    await connection.query('BEGIN');
    return connection;
  }
  it.each(['save', 'publish'])(
    'coordinates save/%s at row/advisory locks: one winner, one conflict, old publication retained',
    async (opponent) => {
      await save({ expected_version: 0, coach_summary: 'base' }).expect(200);
      const connection = await holder();
      await connection.query(
        'SELECT id FROM weekly_recaps WHERE id=$1 FOR UPDATE',
        [recapId],
      );
      const first = save({ expected_version: 1, coach_summary: 'winner' }).then(
        (response) => response,
      );
      let second: Promise<request.Response> | undefined;
      try {
        await waitBlocked('weekly_recaps');
        second = (
          opponent === 'save'
            ? save({ expected_version: 1, changes: 'loser' })
            : publish({ expected_version: 1, confirm: true })
        ).then((response) => response);
        await waitBlocked('pg_advisory_xact_lock(');
      } finally {
        await connection.query('COMMIT');
        connection.release();
      }
      expect((await first).status).toBe(200);
      expect((await second)?.status).toBe(409);
      expect(await stored()).toMatchObject({
        review_version: 2,
        draft_coach_summary: 'winner',
        draft_changes: 'Initial changes',
        published_coach_summary: 'Previous publication',
      });
      await publish({ expected_version: 2, confirm: true }).expect(200);
      expect((await stored()).published_coach_summary).toBe('winner');
    },
  );
  it.each(['assignment', 'staff'])(
    'observes committed %s revocation after a real lock wait before writing',
    async (scope) => {
      await save({ expected_version: 0 }).expect(400); // Prove route first.
      const connection = await holder();
      await connection.query(
        scope === 'assignment'
          ? 'UPDATE admin_client_assignments SET is_active=false WHERE admin_id=$1'
          : 'UPDATE users SET is_active=false WHERE id=$1',
        [adminId],
      );
      const pending = save({
        expected_version: 0,
        changes: 'must not write',
      }).then((response) => response);
      try {
        await waitBlocked(
          scope === 'assignment' ? 'admin_client_assignments' : 'users',
        );
      } finally {
        await connection.query('COMMIT');
        connection.release();
      }
      expect((await pending).status).toBe(403);
      expect((await stored()).review_version).toBe(0);
    },
  );
  it('retains a concurrent legacy writer under the recap lock without copying stale legacy fields', async () => {
    await save({ expected_version: 0, changes: 'New changes' }).expect(200);
    const connection = await holder();
    await connection.query(
      `UPDATE weekly_recaps SET admin_comments=$2,client_feedback_text=$3,
       status='REVIEWED',reviewed_at=$4 WHERE id=$1`,
      [
        recapId,
        'Concurrent internal note',
        'Concurrent legacy feedback',
        originalReview.toISOString(),
      ],
    );
    const pending = publish({ expected_version: 1, confirm: true }).then(
      (response) => response,
    );
    try {
      await waitBlocked('weekly_recaps');
    } finally {
      await connection.query('COMMIT');
      connection.release();
    }
    expect((await pending).status).toBe(200);
    expect(await stored()).toMatchObject({
      review_version: 2,
      published_changes: 'New changes',
      admin_comments: 'Concurrent internal note',
      client_feedback_text: 'Concurrent legacy feedback',
      reviewed_at: originalReview,
    });
    expect(sendToUser).not.toHaveBeenCalled();
  });
  it('does not downgrade publication when a legacy submit resumes with a stale DRAFT snapshot', async () => {
    await prisma.weeklyRecap.update({
      where: { id: recapId },
      data: { status: RecapStatus.DRAFT, submitted_at: null },
    });
    const stale = await prisma.weeklyRecap.findUnique({
      where: { id: recapId },
    });
    actorId = clientId;
    actorRole = Role.CLIENT;
    await request(app.getHttpServer())
      .post(`/recaps/${recapId}/submit`)
      .expect(200);
    actorId = adminId;
    actorRole = Role.ADMIN;
    await publish({ expected_version: 0, confirm: true }).expect(200);
    const confirmed = await stored();
    jest.spyOn(prisma.weeklyRecap, 'findUnique').mockResolvedValueOnce(stale);
    actorId = clientId;
    actorRole = Role.CLIENT;
    await request(app.getHttpServer())
      .post(`/recaps/${recapId}/submit`)
      .expect(403);
    const after = await stored();
    expect(after.status).toBe(RecapStatus.REVIEWED);
    expect(after.reviewed_at).toEqual(confirmed.reviewed_at);
    expect(after.submitted_at).toEqual(confirmed.submitted_at);
    expect(after.review_version).toBe(1);
  });
});
