import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { ConfigService } from '@nestjs/config';
import { EmailService } from '../email/email.service';
import { PrismaService } from '../../prisma/prisma.service';
import { enqueueWork, JobsService } from './jobs.service';
import { resolve } from 'node:path';

const linkMock = jest.fn();
jest.mock('firebase-admin', () => ({
  auth: () => ({ generatePasswordResetLink: linkMock }),
}));
const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)(
  'P6 durable email (PostgreSQL / simulated providers)',
  () => {
    let db: PrismaClient, pool: Pool, jobs: JobsService, email: EmailService;
    let isolated = false;
    let fetchMock: jest.SpiedFunction<typeof fetch>;
    const owner = `p6-email-${process.pid}`;
    const recipient = `${owner}@example.test`;
    const key = `email-test:${owner}`;
    const config = new ConfigService({
      RESEND_API_KEY: 'test-only',
      RESEND_FROM_EMAIL: 'sender@example.test',
      FIREBASE_WEB_API_KEY: 'test-only',
    });
    beforeAll(async () => {
      const target = new URL(url!);
      if (
        target.hostname !== '127.0.0.1' ||
        !['55437', '55447'].includes(target.port) ||
        target.pathname !== '/exom_review'
      )
        throw Error('Local phase6 DB required');
      pool = new Pool({ connectionString: url });
      db = new PrismaClient({ adapter: new PrismaPg(pool) });
      const [identity] = await db.$queryRaw<
        { data_directory: string }[]
      >`SHOW data_directory`;
      expect(resolve(identity.data_directory)).toBe(
        resolve(
          process.cwd(),
          new URL(process.env.TEST_DATABASE_URL ?? '').port === '55447'
            ? '../docs/operations/phase7-20260912/pgdata'
            : '../docs/operations/phase6-20260911/pgdata',
        ),
      );
      Object.assign(db, { postgresqlPool: pool });
      isolated = true;
      await db.user.create({
        data: { id: owner, email: recipient, firebase_uid: owner },
      });
    });
    beforeEach(async () => {
      await db.durableWork.deleteMany({ where: { owner_id: owner } });
      jobs = new JobsService(db as PrismaService);
      email = new EmailService(config, db as PrismaService, jobs);
      email.onModuleInit();
      fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ id: 'email-accepted' }), {
          status: 200,
        }),
      );
      linkMock
        .mockReset()
        .mockResolvedValue('https://example.test/action?test-only');
    });
    afterEach(() => fetchMock.mockRestore());
    afterAll(async () => {
      if (isolated) await db.user.delete({ where: { id: owner } });
      await db?.$disconnect();
      await pool?.end();
    });
    const row = () => db.durableWork.findUniqueOrThrow({ where: { key } });
    const due = () =>
      db.durableWork.update({
        where: { key },
        data: { next_attempt_at: new Date(0) },
      });
    const enqueue = () =>
      enqueueWork(db, key, 'EMAIL', { kind: 'invitation' }, owner);

    it('P6-02: business rollback leaves no email and no provider request', async () => {
      await expect(
        db.$transaction(async (tx) => {
          await tx.user.update({
            where: { id: owner },
            data: { is_locked: true },
          });
          await enqueueWork(tx, key, 'EMAIL', { kind: 'invitation' }, owner);
          throw Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      expect(await db.durableWork.count({ where: { key } })).toBe(0);
      expect(
        (await db.user.findUniqueOrThrow({ where: { id: owner } })).is_locked,
      ).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });
    it('P6-03: provider acceptance is required, with persistent receipt and private payload cleanup', async () => {
      await enqueue();
      await jobs.runKey(key);
      expect(await row()).toMatchObject({
        status: 'DONE',
        payload: {
          kind: 'invitation',
          channel: 'RESEND',
          accepted: true,
          providerMessageId: 'email-accepted',
        },
      });
      expect(JSON.stringify((await row()).payload)).not.toContain(
        'example.test/action',
      );
    });
    it('P6-03: accepted response lost retries exact Resend payload/key, preserving provider deduplication', async () => {
      await enqueue();
      let accepted = 0;
      const seen = new Set<string>();
      const requests: string[] = [];
      fetchMock.mockImplementation((_url, init) => {
        const id = new Headers(init?.headers).get('Idempotency-Key')!;
        if (typeof init?.body !== 'string')
          throw Error('Expected serialized body');
        requests.push(init.body);
        if (!seen.has(id)) {
          seen.add(id);
          accepted++;
          throw Error('response lost');
        }
        return Promise.resolve(
          new Response(JSON.stringify({ id: 'same-acceptance' }), {
            status: 200,
          }),
        );
      });
      await jobs.runKey(key);
      expect((await row()).status).toBe('PENDING');
      await due();
      await jobs.runKey(key);
      expect(accepted).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(requests[1]).toBe(requests[0]);
      expect(linkMock).toHaveBeenCalledTimes(1);
      expect((await row()).status).toBe('DONE');
    });
    it('P6-03: crash before local acceptance receipt retries; after receipt it does not send again', async () => {
      await enqueue();
      const delegateBeforeSpy = { ...db.durableWork };
      let crashed = false;
      const spy = jest
        .spyOn(db.durableWork, 'update')
        .mockImplementation((args) => {
          if (
            !crashed &&
            JSON.stringify(args.data.payload).includes('"accepted":true')
          ) {
            crashed = true;
            throw Error('crash');
          }
          return delegateBeforeSpy.update(args);
        });
      await jobs.runKey(key);
      spy.mockRestore();
      await due();
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ id: 'email-accepted' }), { status: 200 }),
      );
      await jobs.runKey(key);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await db.durableWork.update({
        where: { key },
        data: { status: 'PENDING', next_attempt_at: new Date(0) },
      });
      await jobs.runKey(key);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    it('P6-03: invalid/ambiguous acceptance does not become success', async () => {
      await enqueue();
      fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
      await jobs.runKey(key);
      expect((await row()).status).toBe('PENDING');
      expect((await row()).payload).not.toHaveProperty('accepted', true);
    });
    it('P6-03: expired Resend dedup window is a visible definitive failure, not another send', async () => {
      await enqueue();
      fetchMock.mockRejectedValueOnce(Error('lost'));
      await jobs.runKey(key);
      const payload = (await row()).payload;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        throw Error('Fixture');
      await db.durableWork.update({
        where: { key },
        data: {
          payload: { ...payload, preparedAt: new Date(0).toISOString() },
          next_attempt_at: new Date(0),
        },
      });
      await jobs.runKey(key);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(await row()).toMatchObject({
        status: 'FAILED',
        last_error: 'EMAIL_DEDUP_WINDOW_EXPIRED',
      });
    });
    it('P6-03: missing email configuration fails visibly', async () => {
      jobs = new JobsService(db as PrismaService);
      email = new EmailService(
        new ConfigService({}),
        db as PrismaService,
        jobs,
      );
      email.onModuleInit();
      await enqueue();
      await jobs.runKey(key);
      expect(await row()).toMatchObject({
        status: 'FAILED',
        last_error: 'EMAIL_PROVIDER_NOT_CONFIGURED',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });
    it('P6-03: a stale worker cannot send or overwrite a newer acceptance receipt', async () => {
      await enqueue();
      const stale = await db.durableWork.update({
        where: { key },
        data: { status: 'RUNNING', claim_token: 'old', attempts: 1 },
      });
      await db.durableWork.update({
        where: { key },
        data: {
          status: 'DONE',
          claim_token: null,
          payload: {
            kind: 'invitation',
            channel: 'RESEND',
            accepted: true,
            providerMessageId: 'newer-receipt',
          },
        },
      });
      await expect(email.deliver(stale)).rejects.toThrow('CLAIM_LOST');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(await row()).toMatchObject({
        status: 'DONE',
        payload: { accepted: true, providerMessageId: 'newer-receipt' },
      });
    });

    it('P6-03: Firebase retries never switch to another email address', async () => {
      jobs = new JobsService(db as PrismaService);
      email = new EmailService(
        new ConfigService({ FIREBASE_WEB_API_KEY: 'test-only' }),
        db as PrismaService,
        jobs,
      );
      email.onModuleInit();
      await enqueue();
      fetchMock.mockRejectedValue(Error('response lost'));
      await jobs.runKey(key);
      await db.user.update({
        where: { id: owner },
        data: { email: `changed-${recipient}` },
      });
      try {
        await due();
        await jobs.runKey(key);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(await row()).toMatchObject({
          status: 'FAILED',
          last_error: 'EMAIL_RECIPIENT_CHANGED',
        });
      } finally {
        await db.user.update({
          where: { id: owner },
          data: { email: recipient },
        });
      }
    });

    it('P6-03: Firebase email has residual duplicates on response loss and requires an acceptance response', async () => {
      jobs = new JobsService(db as PrismaService);
      email = new EmailService(
        new ConfigService({ FIREBASE_WEB_API_KEY: 'test-only' }),
        db as PrismaService,
        jobs,
      );
      email.onModuleInit();
      await enqueue();
      fetchMock.mockRejectedValueOnce(Error('accepted but response lost'));
      await jobs.runKey(key);
      await due();
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ email: recipient }), { status: 200 }),
      );
      await jobs.runKey(key);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(await row()).toMatchObject({
        status: 'DONE',
        payload: { channel: 'FIREBASE_EMAIL', accepted: true },
      });
    });
  },
);
