import type { Server } from 'node:http';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { RecapStatus, Role } from '@prisma/client';
import { Reflector } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { assertTestDatabase } from '../../../scripts/test-database.cjs';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { RecapsController } from './recaps.controller';
import { RecapsService } from './recaps.service';

type AuthenticatedRequest = Request & { user?: AuthenticatedUser };

const privateFields = [
  'admin_comments',
  'draft_coach_summary',
  'draft_changes',
  'draft_next_week_goals',
  'review_version',
];
function expectClientProjection(body: unknown) {
  for (const field of privateFields) expect(body).not.toHaveProperty(field);
}

const postgresSuite =
  process.env.FOLLOWUP_HTTP_PG === '1' ? describe : describe.skip;
postgresSuite('REST-T3-PRIVACY-01 real recap HTTP/PG projection', () => {
  let app: INestApplication<Server>;
  let prisma: PrismaService;
  let clientId: string;
  let recapId: string;
  let callerId: string;
  let callerRole: Role;
  const notes = '  Internal coach note ñ\r\n  ';
  const reviewStorage = {
    draft_coach_summary: 'draft summary',
    draft_changes: 'draft changes',
    draft_next_week_goals: 'draft goals',
    published_coach_summary: 'published summary',
    published_changes: 'published changes',
    published_next_week_goals: 'published goals',
    review_version: 7,
  };
  const sendToUser = jest.fn();
  const dates = {
    week_start_date: '2026-01-05',
    week_end_date: '2026-01-11',
  };
  beforeEach(async () => {
    prisma = new PrismaService();
    await assertTestDatabase(prisma.postgresqlPool);
    clientId = randomUUID();
    await prisma.user.create({
      data: {
        id: clientId,
        email: `${clientId}@example.test`,
        firebase_uid: clientId,
        role: Role.CLIENT,
      },
    });
    const recap = await prisma.weeklyRecap.create({
      data: {
        client_id: clientId,
        week_start_date: new Date(dates.week_start_date),
        week_end_date: new Date(dates.week_end_date),
        admin_comments: notes,
        client_feedback_text: 'Shareable feedback',
        client_feedback_sent_at: new Date('2026-01-12T01:02:03.456Z'),
        training_notes: 'Client training answer',
        ...reviewStorage,
      },
    });
    recapId = recap.id;
    callerId = clientId;
    callerRole = Role.CLIENT;
    const moduleRef = await Test.createTestingModule({
      controllers: [RecapsController],
      providers: [
        RecapsService,
        { provide: PrismaService, useValue: prisma },
        { provide: NotificationsService, useValue: { sendToUser } },
      ],
    }).compile();
    app = moduleRef.createNestApplication<INestApplication<Server>>();
    app.use((req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
      req.user = {
        id: callerId,
        role: callerRole,
        email: 'synthetic@example.test',
        firebase_uid: callerId,
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
    await app?.close(); // Connections only; owned fixture rows are retained.
    sendToUser.mockClear();
  });

  it.each(['create', 'overwrite', 'update', 'submit'])(
    'omits notes from %s and equivalent reads while preserving stored/admin notes',
    async (operation) => {
      const server = app.getHttpServer();
      if (operation === 'create' || operation === 'overwrite') {
        const response = await request(server)
          .post('/recaps')
          .send(
            operation === 'create'
              ? { week_start_date: '2026-01-12', week_end_date: '2026-01-18' }
              : dates,
          )
          .expect(201);
        expectClientProjection(response.body as unknown);
      } else if (operation === 'update') {
        const response = await request(server)
          .put(`/recaps/${recapId}`)
          .send({ training_notes: 'Updated client answer' })
          .expect(200);
        expectClientProjection(response.body as unknown);
      } else {
        const response = await request(server)
          .post(`/recaps/${recapId}/submit`)
          .expect(200);
        expectClientProjection(response.body as unknown);
      }
      const detail = await request(server)
        .get(`/recaps/my/${recapId}`)
        .expect(200);
      expectClientProjection(detail.body as unknown);
      expect(detail.body as unknown).toMatchObject({
        client_feedback_text: 'Shareable feedback',
        client_feedback_sent_at: '2026-01-12T01:02:03.456Z',
        published_coach_summary: reviewStorage.published_coach_summary,
        published_changes: reviewStorage.published_changes,
        published_next_week_goals: reviewStorage.published_next_week_goals,
      });
      const list = await request(server).get('/recaps/my').expect(200);
      const page: unknown = list.body;
      if (
        typeof page !== 'object' ||
        page === null ||
        !('data' in page) ||
        !Array.isArray(page.data)
      )
        throw new Error('Expected a paginated recap list');
      expect(
        page.data.some(
          (item: unknown) =>
            typeof item === 'object' &&
            item !== null &&
            'id' in item &&
            item.id === recapId,
        ),
      ).toBe(true);
      for (const item of page.data) expectClientProjection(item);
      const read = await request(server)
        .post(`/recaps/my/${recapId}/read-feedback`)
        .expect(200);
      expect(read.body as unknown).toEqual({ success: true });
      const stored = await prisma.weeklyRecap.findUniqueOrThrow({
        where: { id: recapId },
      });
      expect(stored).toMatchObject({ admin_comments: notes, ...reviewStorage });
      callerRole = Role.SUPER_ADMIN;
      const admin = await request(server).get(`/recaps/${recapId}`).expect(200);
      expect(admin.body as unknown).toMatchObject({ admin_comments: notes });
      expect(sendToUser).not.toHaveBeenCalled();
    },
  );

  it.each(['create', 'update'])(
    'rejects internal notes/review storage in client %s DTOs',
    async (operation) => {
      for (const field of [
        ...privateFields,
        'published_coach_summary',
        'published_changes',
        'published_next_week_goals',
        'client_feedback_text',
      ]) {
        const response = request(app.getHttpServer());
        if (operation === 'create')
          await response
            .post('/recaps')
            .send({ ...dates, [field]: 'forbidden' })
            .expect(400);
        else
          await response
            .put(`/recaps/${recapId}`)
            .send({ [field]: 'forbidden' })
            .expect(400);
      }
      const stored = await prisma.weeklyRecap.findUniqueOrThrow({
        where: { id: recapId },
      });
      expect(stored).toMatchObject({ admin_comments: notes, ...reviewStorage });
    },
  );

  it('keeps real role checks on admin detail/review and client writes', async () => {
    await request(app.getHttpServer()).get(`/recaps/${recapId}`).expect(403);
    await request(app.getHttpServer())
      .put(`/recaps/${recapId}/review`)
      .send({ admin_comments: 'forbidden' })
      .expect(403);
    callerRole = Role.ADMIN;
    await request(app.getHttpServer())
      .put(`/recaps/${recapId}`)
      .send({ training_notes: 'forbidden' })
      .expect(403);
  });

  it('rejects cross-owner detail/update/submit/read-feedback', async () => {
    callerId = randomUUID();
    const server = app.getHttpServer();
    await request(server).get(`/recaps/my/${recapId}`).expect(403);
    await request(server)
      .put(`/recaps/${recapId}`)
      .send({ training_notes: 'forbidden' })
      .expect(403);
    await request(server).post(`/recaps/${recapId}/submit`).expect(403);
    await request(server)
      .post(`/recaps/my/${recapId}/read-feedback`)
      .expect(403);
    const stored = await prisma.weeklyRecap.findUniqueOrThrow({
      where: { id: recapId },
    });
    expect(stored).toMatchObject({
      admin_comments: notes,
      training_notes: 'Client training answer',
      status: RecapStatus.DRAFT,
    });
  });
});

describe('RecapsController', () => {
  let app: INestApplication<Server>;
  const recapsService = {
    create: jest.fn(),
    findMyRecaps: jest.fn(),
    getMyRecapById: jest.fn(),
    markClientFeedbackAsRead: jest.fn(),
    findForAdmin: jest.fn(),
    getStats: jest.fn(),
    getAdminRecapById: jest.fn(),
    update: jest.fn(),
    submit: jest.fn(),
    review: jest.fn(),
    archive: jest.fn(),
  };

  beforeEach(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [RecapsController],
      providers: [
        {
          provide: RecapsService,
          useValue: recapsService,
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use((req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
      req.user = {
        id: 'admin-1',
        email: 'admin-1@exom.dev',
        role: 'ADMIN',
        firebase_uid: 'firebase-admin-1',
      };
      next();
    });
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
    jest.clearAllMocks();
    await app.close();
  });

  it('rejects invalid recap status filters with 400', async () => {
    await request(app.getHttpServer())
      .get('/recaps')
      .query({ status: 'INVALID' })
      .expect(400);

    expect(recapsService.findForAdmin).not.toHaveBeenCalled();
  });

  it('rejects draft recap status filters with 400', async () => {
    await request(app.getHttpServer())
      .get('/recaps')
      .query({ status: RecapStatus.DRAFT })
      .expect(400);

    expect(recapsService.findForAdmin).not.toHaveBeenCalled();
  });

  it('passes validated admin recap filters to the service', async () => {
    recapsService.findForAdmin.mockResolvedValue({
      data: [],
      total: 0,
      page: 2,
      limit: 10,
      totalPages: 0,
    });

    await request(app.getHttpServer())
      .get('/recaps')
      .query({
        client_id: '550e8400-e29b-41d4-a716-446655440000',
        status: RecapStatus.REVIEWED,
        archived: 'true',
        page: '2',
        limit: '10',
      })
      .expect(200);

    expect(recapsService.findForAdmin).toHaveBeenCalledWith(
      'admin-1',
      'ADMIN',
      expect.objectContaining({
        client_id: '550e8400-e29b-41d4-a716-446655440000',
        status: RecapStatus.REVIEWED,
        archived: true,
        page: 2,
        limit: 10,
      }),
    );
  });

  it('rejects the legacy notes field in review payloads', async () => {
    await request(app.getHttpServer())
      .put('/recaps/recap-1/review')
      .send({ notes: 'legacy comment' })
      .expect(400);

    expect(recapsService.review).not.toHaveBeenCalled();
  });

  it('routes mark-feedback requests through the client endpoint', async () => {
    recapsService.markClientFeedbackAsRead.mockResolvedValue({ success: true });

    await request(app.getHttpServer())
      .post('/recaps/my/recap-1/read-feedback')
      .expect(200);

    expect(recapsService.markClientFeedbackAsRead).toHaveBeenCalledWith(
      'admin-1',
      'recap-1',
    );
  });
});
