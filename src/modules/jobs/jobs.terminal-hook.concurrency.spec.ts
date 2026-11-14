import { Logger } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { assertTestDatabase } from '../../../scripts/test-database.cjs';
import { PrismaService } from '../../prisma/prisma.service';
import {
  enqueueWork,
  JobsService,
  PermanentWorkError,
  TERMINAL_HOOK_TRIES,
} from './jobs.service';

const url = process.env.TEST_DATABASE_URL;

(url ? describe : describe.skip)(
  'JobsService terminal-failure hook (PostgreSQL)',
  () => {
    let pool: Pool;
    let db: PrismaClient;
    let isolated = false;
    const prefix = `hook-test-${process.pid}-${Date.now()}`;
    const keys: string[] = [];

    beforeAll(async () => {
      pool = new Pool({ connectionString: url, max: 4 });
      await assertTestDatabase(pool);
      isolated = true;
      db = new PrismaClient({ adapter: new PrismaPg(pool) });
      Object.assign(db, { postgresqlPool: pool });
    });

    afterAll(async () => {
      if (isolated)
        await db.durableWork.deleteMany({ where: { key: { in: keys } } });
      await db?.$disconnect();
      await pool?.end();
    });

    async function setup(
      name: string,
      hook: (tx: Prisma.TransactionClient) => Promise<void>,
    ) {
      const kind = `${prefix}-${name}`;
      const key = `${kind}:1`;
      keys.push(key);
      const jobs = new JobsService(db as PrismaService);
      const handler = jest.fn(() =>
        Promise.reject(new PermanentWorkError('TEST_PERMANENT')),
      );
      const onTerminalFailure = jest.fn(hook);
      jobs.register(kind, handler, { onTerminalFailure });
      await enqueueWork(db, key, kind, { name });
      return { jobs, key, handler, onTerminalFailure };
    }

    it('a hook that always throws is bounded: the item ends FAILED, logged without PII', async () => {
      const errors = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      try {
        const { jobs, key, handler, onTerminalFailure } = await setup(
          'always',
          () => Promise.reject(new Error('ana@example.test leaked')),
        );
        await jobs.runKey(key);
        expect(handler).toHaveBeenCalledTimes(1);
        expect(onTerminalFailure).toHaveBeenCalledTimes(TERMINAL_HOOK_TRIES);
        expect(
          await db.durableWork.findUniqueOrThrow({ where: { key } }),
        ).toMatchObject({
          status: 'FAILED',
          last_error: 'TEST_PERMANENT',
          claim_token: null,
          lease_until: null,
          attempts: 1,
        });
        // Terminal: never picked up again, even once a lease would expire.
        await db.durableWork.update({
          where: { key },
          data: { next_attempt_at: new Date(0) },
        });
        await jobs.runKey(key);
        expect(handler).toHaveBeenCalledTimes(1);
        expect(onTerminalFailure).toHaveBeenCalledTimes(TERMINAL_HOOK_TRIES);
        const logged = errors.mock.calls.map((call) => String(call[0]));
        expect(logged).toHaveLength(TERMINAL_HOOK_TRIES + 1);
        expect(logged.join('\n')).not.toContain('ana@example.test');
        expect(logged.at(-1)).toContain('FAILED without its terminal hook');
      } finally {
        errors.mockRestore();
      }
    });

    it('a hook that fails once is retried in a new transaction and its writes commit', async () => {
      const errors = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      let calls = 0;
      try {
        const marker = `${prefix}-marker`;
        keys.push(marker);
        const { jobs, key, onTerminalFailure } = await setup(
          'once',
          async (tx) => {
            calls += 1;
            // Written in the hook's transaction: the failed try rolls back.
            await enqueueWork(tx, marker, `${prefix}-marker`, { calls });
            if (calls === 1) throw new Error('transient');
          },
        );
        await jobs.runKey(key);
        expect(onTerminalFailure).toHaveBeenCalledTimes(1 + 1);
        expect(
          await db.durableWork.findUniqueOrThrow({ where: { key } }),
        ).toMatchObject({ status: 'FAILED', last_error: 'TEST_PERMANENT' });
        expect(errors).toHaveBeenCalledTimes(1);
        expect(
          await db.durableWork.findUniqueOrThrow({ where: { key: marker } }),
        ).toMatchObject({ payload: { calls: 2 } });
      } finally {
        errors.mockRestore();
      }
    });
  },
);
