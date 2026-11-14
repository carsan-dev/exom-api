import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { JobsService } from '../jobs/jobs.service';
import { classifyResendFailure, EmailService } from './email.service';

jest.mock('firebase-admin', () => ({ auth: () => ({}) }));

const request = {
  from: 'EXOM <sender@example.test>',
  to: 'ana@example.test',
  subject: 'EXOM · Tu material del mes 1',
  html: '<p>hola</p>',
  text: 'hola',
  attachments: [{ filename: 'a.pdf', content: 'JVBERi0=' }],
};

const pools: PrismaService[] = [];
afterAll(async () => {
  await Promise.all(pools.map((prisma) => prisma.postgresqlPool.end()));
});

function service(config: Record<string, string>) {
  // Neither Prisma nor jobs are touched by sendResendEmail: the lazy pool
  // never connects. The URL is restored so no other suite sees it.
  const previous = {
    url: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL_MODE,
  };
  process.env.DATABASE_URL = 'postgresql://unused:unused@127.0.0.1:1/unused';
  process.env.DATABASE_SSL_MODE = 'disable';
  let prisma: PrismaService;
  try {
    prisma = new PrismaService();
  } finally {
    if (previous.url === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous.url;
    if (previous.ssl === undefined) delete process.env.DATABASE_SSL_MODE;
    else process.env.DATABASE_SSL_MODE = previous.ssl;
  }
  pools.push(prisma);
  return new EmailService(
    new ConfigService(config),
    prisma,
    new JobsService(prisma),
  );
}

describe('classifyResendFailure', () => {
  it.each([
    [
      409,
      'concurrent_idempotent_requests',
      'transient',
      'EMAIL_IDEMPOTENCY_IN_PROGRESS',
    ],
    [
      409,
      'invalid_idempotent_request',
      'permanent',
      'EMAIL_IDEMPOTENCY_CONFLICT',
    ],
    [429, 'rate_limit_exceeded', 'transient', 'EMAIL_PROVIDER_RATE_LIMITED'],
    [500, undefined, 'transient', 'EMAIL_PROVIDER_UNAVAILABLE'],
    [503, undefined, 'transient', 'EMAIL_PROVIDER_UNAVAILABLE'],
    [401, 'missing_api_key', 'permanent', 'EMAIL_PROVIDER_AUTH_REJECTED'],
    [403, 'invalid_api_key', 'permanent', 'EMAIL_PROVIDER_AUTH_REJECTED'],
    [422, 'validation_error', 'permanent', 'EMAIL_REQUEST_REJECTED'],
    [400, 'validation_error', 'permanent', 'EMAIL_REQUEST_REJECTED'],
    [404, 'not_found', 'permanent', 'EMAIL_PROVIDER_REJECTED'],
  ])('%i %s -> %s %s', (status, name, outcome, code) => {
    expect(classifyResendFailure(status, name)).toEqual({ outcome, code });
  });
});

describe('EmailService.sendResendEmail', () => {
  let fetchMock: jest.SpiedFunction<typeof fetch>;
  const configured = {
    RESEND_API_KEY: 'test-only-key',
    RESEND_FROM_EMAIL: 'EXOM <sender@example.test>',
  };

  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });
  afterEach(() => fetchMock.mockRestore());

  it('posts attachments with the caller idempotency key and returns the id', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: 'msg-1' }), { status: 200 }),
    );
    const result = await service(configured).sendResendEmail(
      request,
      'base-delivery:d:1',
    );
    expect(result).toEqual({ outcome: 'accepted', id: 'msg-1' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    const headers = new Headers(init?.headers);
    expect(headers.get('Idempotency-Key')).toBe('base-delivery:d:1');
    expect(headers.get('Authorization')).toBe('Bearer test-only-key');
    expect(init?.body).toBe(JSON.stringify(request));
  });

  it('classifies provider errors by status and error name only', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          statusCode: 422,
          name: 'validation_error',
          message: 'Invalid `to` field: ana@example.test',
        }),
        { status: 422 },
      ),
    );
    const result = await service(configured).sendResendEmail(request, 'k');
    expect(result).toEqual({
      outcome: 'permanent',
      code: 'EMAIL_REQUEST_REJECTED',
    });
    expect(JSON.stringify(result)).not.toContain('ana@');
  });

  it('treats a network failure as transient (same key may be retried)', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));
    await expect(
      service(configured).sendResendEmail(request, 'k'),
    ).resolves.toEqual({
      outcome: 'transient',
      code: 'EMAIL_PROVIDER_UNREACHABLE',
    });
  });

  it('treats a success without id as transient', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    await expect(
      service(configured).sendResendEmail(request, 'k'),
    ).resolves.toEqual({
      outcome: 'transient',
      code: 'EMAIL_ACCEPTANCE_MISSING',
    });
  });

  it('never falls back to another provider when Resend is not configured', async () => {
    const email = service({ FIREBASE_WEB_API_KEY: 'test-only' });
    expect(email.resendSender()).toBeUndefined();
    await expect(email.sendResendEmail(request, 'k')).resolves.toEqual({
      outcome: 'permanent',
      code: 'EMAIL_PROVIDER_NOT_CONFIGURED',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
