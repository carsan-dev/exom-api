import type { Server } from 'node:http';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Role } from '@prisma/client';
import request from 'supertest';
import * as identity from '../../common/firebase/firebase-id-token';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { AllExceptionsFilter } from '../../common/filters/http-exception.filter';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { TransformInterceptor } from '../../common/interceptors/transform.interceptor';
import { PrismaService } from '../../prisma/prisma.service';
import { BaseDeliveriesService } from './base-deliveries.service';
import { BASE_SERVICE_ROLES } from './base-service.constants';
import { BaseServiceController } from './base-service.controller';
import { baseHttp } from './base-service.http-errors';
import { BaseSubscribersService } from './base-subscribers.service';

const SUBSCRIBER = '6f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7';
const DELIVERY = '0a1b2c3d-4e5f-4061-8273-94a5b6c7d8e9';
const PREFIX = '/api/v1/admin/base-service';

type Method = 'get' | 'post' | 'patch' | 'put';
const ROUTES: [Method, string, object | undefined][] = [
  ['get', '/routes', undefined],
  ['get', '/subscribers', undefined],
  [
    'post',
    '/subscribers',
    {
      name: 'Ana',
      email: 'ana@example.test',
      goal: 'perder-grasa',
      days_per_week: 3,
    },
  ],
  ['get', `/subscribers/${SUBSCRIBER}`, undefined],
  ['patch', `/subscribers/${SUBSCRIBER}`, { notes: 'x' }],
  ['put', `/subscribers/${SUBSCRIBER}/archive`, { is_archived: true }],
  ['get', `/subscribers/${SUBSCRIBER}/deliveries`, undefined],
  ['post', `/subscribers/${SUBSCRIBER}/deliveries`, { month: 1 }],
  [
    'post',
    `/subscribers/${SUBSCRIBER}/deliveries/${DELIVERY}/resend`,
    undefined,
  ],
];

const USERS: Record<string, { role: Role }> = {
  'token-admin': { role: Role.ADMIN },
  'token-super': { role: Role.SUPER_ADMIN },
  'token-client': { role: Role.CLIENT },
};

describe('Base service HTTP: guards, validation and error contract', () => {
  let app: INestApplication<Server>;
  const subscribers = {
    routes: jest.fn(),
    list: jest.fn(),
    create: jest.fn(),
    get: jest.fn(),
    update: jest.fn(),
    setArchived: jest.fn(),
  };
  const deliveries = { list: jest.fn(), create: jest.fn(), resend: jest.fn() };
  const allMocks = [
    ...Object.values(subscribers),
    ...Object.values(deliveries),
  ];

  beforeAll(async () => {
    jest
      .spyOn(identity, 'verifyFirebaseIdTokenWithFallback')
      .mockImplementation(({ token }) =>
        USERS[token]
          ? Promise.resolve({ uid: token })
          : Promise.reject(new identity.FirebaseIdTokenRejectedError()),
      );
    const prisma = {
      user: {
        findUnique: jest.fn(
          ({ where }: { where: { firebase_uid: string } }) => {
            const user = USERS[where.firebase_uid];
            return Promise.resolve(
              user
                ? {
                    id: `id-${where.firebase_uid}`,
                    email: `${where.firebase_uid}@example.test`,
                    role: user.role,
                    firebase_uid: where.firebase_uid,
                    is_active: true,
                    is_locked: false,
                    identity_pending: false,
                    sessions_revoked_at: null,
                  }
                : null,
            );
          },
        ),
      },
    };
    const testing = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ ignoreEnvFile: true, isGlobal: true })],
      controllers: [BaseServiceController],
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: BaseSubscribersService, useValue: subscribers },
        { provide: BaseDeliveriesService, useValue: deliveries },
        { provide: APP_GUARD, useClass: FirebaseAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();
    app = testing.createNestApplication();
    app.setGlobalPrefix('api/v1');
    // Exact production pipe options, including implicit conversion.
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new TransformInterceptor());
    await app.init();
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  beforeEach(() => {
    for (const mock of allMocks) mock.mockReset().mockResolvedValue({ ok: 1 });
  });

  function call(method: Method, path: string, body?: object, token?: string) {
    const server = app.getHttpServer();
    const req = request(server)[method](PREFIX + path);
    if (token) req.set('Authorization', `Bearer ${token}`);
    return body === undefined
      ? req
      : req.type('json').send(JSON.stringify(body));
  }

  it('protects the whole controller with the single role constant', () => {
    expect(Reflect.getMetadata(ROLES_KEY, BaseServiceController)).toEqual(
      BASE_SERVICE_ROLES,
    );
    const prototype = BaseServiceController.prototype;
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name === 'constructor') continue;
      const handler: unknown = Reflect.get(prototype, name);
      if (typeof handler !== 'function') continue;
      // No handler loosens or overrides the class-level role list.
      expect(Reflect.getMetadata(ROLES_KEY, handler)).toBeUndefined();
    }
  });

  it.each(ROUTES)('%s %s requires a token', async (method, path, body) => {
    const response = await call(method, path, body);
    expect(response.status).toBe(401);
    for (const mock of allMocks) expect(mock).not.toHaveBeenCalled();
  });

  it.each(ROUTES)('%s %s rejects CLIENT', async (method, path, body) => {
    const response = await call(method, path, body, 'token-client');
    expect(response.status).toBe(403);
    for (const mock of allMocks) expect(mock).not.toHaveBeenCalled();
  });

  it.each(ROUTES)(
    '%s %s allows ADMIN and SUPER_ADMIN',
    async (method, path, body) => {
      for (const token of ['token-admin', 'token-super']) {
        const response = await call(method, path, body, token);
        expect([200, 201]).toContain(response.status);
        expect(response.body).toMatchObject({ success: true, data: { ok: 1 } });
      }
    },
  );

  it('passes the authenticated actor and parsed input to the services', async () => {
    await call(
      'post',
      `/subscribers/${SUBSCRIBER}/deliveries`,
      { month: 2 },
      'token-admin',
    );
    expect(deliveries.create).toHaveBeenCalledWith(
      SUBSCRIBER,
      2,
      expect.objectContaining({ id: 'id-token-admin', role: Role.ADMIN }),
    );
    await call(
      'get',
      '/subscribers?q=ana&archive=all&page=2&limit=5',
      undefined,
      'token-super',
    );
    expect(subscribers.list).toHaveBeenCalledWith(
      expect.objectContaining({ q: 'ana', archive: 'all', page: 2, limit: 5 }),
    );
  });

  it.each([
    [
      'post',
      '/subscribers',
      { email: 'a@example.test', goal: 'x', days_per_week: 3 },
    ],
    [
      'post',
      '/subscribers',
      { name: 'Ana', email: 'not-an-email', goal: 'x', days_per_week: 3 },
    ],
    [
      'post',
      '/subscribers',
      {
        name: 'Ana',
        email: 'a@example.test',
        goal: 'Perder Grasa',
        days_per_week: 3,
      },
    ],
    [
      'post',
      '/subscribers',
      { name: 'Ana', email: 'a@example.test', goal: 'x', days_per_week: '3' },
    ],
    [
      'post',
      '/subscribers',
      { name: 123, email: 'a@example.test', goal: 'x', days_per_week: 3 },
    ],
    [
      'post',
      '/subscribers',
      { name: 'Ana', email: 'a@example.test', goal: 'x', days_per_week: 8 },
    ],
    [
      'post',
      '/subscribers',
      {
        name: 'Ana',
        email: 'a@example.test',
        goal: 'x',
        days_per_week: 3,
        order_code: 'X',
      },
    ],
    ...['training', 'ALL', '', 1, null, ['BOTH']].map(
      (service_scope): [Method, string, object] => [
        'post',
        '/subscribers',
        {
          name: 'Ana',
          email: 'a@example.test',
          goal: 'x',
          days_per_week: 3,
          service_scope,
        },
      ],
    ),
    ['patch', `/subscribers/${SUBSCRIBER}`, { service_scope: 'nutrition' }],
    ['patch', `/subscribers/${SUBSCRIBER}`, { service_scope: null }],
    ['patch', `/subscribers/${SUBSCRIBER}`, { is_archived: true }],
    ['patch', `/subscribers/${SUBSCRIBER}`, { days_per_week: 0 }],
    ['patch', '/subscribers/not-a-uuid', { notes: 'x' }],
    ['put', `/subscribers/${SUBSCRIBER}/archive`, { is_archived: 'true' }],
    ['post', `/subscribers/${SUBSCRIBER}/deliveries`, { month: '2' }],
    ['post', `/subscribers/${SUBSCRIBER}/deliveries`, { month: 0 }],
    ['post', `/subscribers/${SUBSCRIBER}/deliveries`, { month: 1.5 }],
    ['post', `/subscribers/${SUBSCRIBER}/deliveries`, {}],
    ['get', '/subscribers?limit=101', undefined],
    ['get', '/subscribers?archive=deleted', undefined],
    [
      'post',
      `/subscribers/${SUBSCRIBER}/deliveries/not-a-uuid/resend`,
      undefined,
    ],
    [
      'post',
      `/subscribers/${SUBSCRIBER}/deliveries/${DELIVERY}/resend`,
      { accept_changed_source: 'true' },
    ],
    [
      'post',
      `/subscribers/${SUBSCRIBER}/deliveries/${DELIVERY}/resend`,
      { accept_changed_source: 1 },
    ],
    [
      'post',
      `/subscribers/${SUBSCRIBER}/deliveries/${DELIVERY}/resend`,
      { accept_changed_source: null },
    ],
    [
      'post',
      `/subscribers/${SUBSCRIBER}/deliveries/${DELIVERY}/resend`,
      { accept_changed_source: true, force: true },
    ],
  ] as [Method, string, object | undefined][])(
    'rejects invalid input %#: %s %s',
    async (method, path, body) => {
      const response = await call(method, path, body, 'token-admin');
      expect(response.status).toBe(400);
      for (const mock of allMocks) expect(mock).not.toHaveBeenCalled();
    },
  );

  it('service_scope: optional on create, accepted on edit, one of TRAINING | NUTRITION | BOTH', async () => {
    const base = {
      name: 'Ana',
      email: 'a@example.test',
      goal: 'x',
      days_per_week: 3,
    };
    // Older admin builds send no scope: still valid, the service defaults it.
    let received: object | undefined;
    subscribers.create.mockImplementationOnce((dto: object) => {
      received = dto;
      return Promise.resolve({ ok: 1 });
    });
    const legacy = await call('post', '/subscribers', base, 'token-admin');
    expect(legacy.status).toBe(201);
    // toEqual ignores undefined properties: no scope value reaches the service.
    expect(received).toEqual(base);
    for (const service_scope of ['TRAINING', 'NUTRITION', 'BOTH']) {
      const created = await call(
        'post',
        '/subscribers',
        { ...base, service_scope },
        'token-admin',
      );
      expect(created.status).toBe(201);
      expect(subscribers.create).toHaveBeenLastCalledWith(
        expect.objectContaining({ service_scope }),
        expect.objectContaining({ id: 'id-token-admin' }),
      );
      const edited = await call(
        'patch',
        `/subscribers/${SUBSCRIBER}`,
        { service_scope },
        'token-admin',
      );
      expect(edited.status).toBe(200);
      expect(subscribers.update).toHaveBeenLastCalledWith(
        SUBSCRIBER,
        expect.objectContaining({ service_scope }),
        expect.objectContaining({ id: 'id-token-admin' }),
      );
    }
  });

  it('resend: no body (older admin builds), {} and false never confirm; true does', async () => {
    const path = `/subscribers/${SUBSCRIBER}/deliveries/${DELIVERY}/resend`;
    const cases: [object | undefined, boolean][] = [
      [undefined, false],
      [{}, false],
      [{ accept_changed_source: false }, false],
      [{ accept_changed_source: true }, true],
    ];
    for (const [body, confirmed] of cases) {
      deliveries.resend.mockClear();
      const response = await call('post', path, body, 'token-admin');
      expect(response.status).toBe(201);
      expect(deliveries.resend).toHaveBeenCalledWith(
        SUBSCRIBER,
        DELIVERY,
        expect.objectContaining({ id: 'id-token-admin', role: Role.ADMIN }),
        { acceptChangedSource: confirmed },
      );
    }
  });

  it('forwards SOURCE_CHANGED_SINCE_DELIVERY with its code for the admin to ask for confirmation', async () => {
    deliveries.resend.mockRejectedValue(
      baseHttp.conflict('SOURCE_CHANGED_SINCE_DELIVERY', 'mensaje'),
    );
    const response = await call(
      'post',
      `/subscribers/${SUBSCRIBER}/deliveries/${DELIVERY}/resend`,
      undefined,
      'token-admin',
    );
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: 'SOURCE_CHANGED_SINCE_DELIVERY',
      message: 'mensaje',
    });
  });

  it('forwards the machine code and Spanish message of service errors', async () => {
    deliveries.create.mockRejectedValue(
      baseHttp.conflict(
        'MONTH_NOT_NEXT',
        'Solo se puede enviar el mes 2 a este suscriptor.',
      ),
    );
    const response = await call(
      'post',
      `/subscribers/${SUBSCRIBER}/deliveries`,
      { month: 3 },
      'token-admin',
    );
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      statusCode: 409,
      error: 'Conflict',
      code: 'MONTH_NOT_NEXT',
      message: 'Solo se puede enviar el mes 2 a este suscriptor.',
    });
  });
});
