import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DurableWork, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { withWorkGuard } from './work-guard';

export const workContext = new AsyncLocalStorage<DurableWork>();
export class PermanentWorkError extends Error {}
export class RetryWorkError extends Error {}
type Handler = (work: DurableWork) => Promise<void>;
export const WORK_CONCURRENCY = 4;
export const WORK_LEASE_MS = 300_000;
export const WORK_MAX_ATTEMPTS = 8;

export async function enqueueWork(
  db: Pick<Prisma.TransactionClient, 'durableWork'>,
  key: string,
  kind: string,
  payload: Prisma.InputJsonObject,
  ownerId?: string,
) {
  // Prisma can emulate an empty-update upsert with SELECT/INSERT, which races.
  // createMany(skipDuplicates) always asks PostgreSQL to resolve the conflict.
  return db.durableWork.createMany({
    data: [{ key, kind, payload, owner_id: ownerId }],
    skipDuplicates: true,
  });
}

@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);
  private readonly handlers = new Map<string, Handler>();
  private readonly activeSlots = new Set<number>();
  constructor(private readonly prisma: PrismaService) {}

  register(kind: string, handler: Handler) {
    if (this.handlers.has(kind))
      throw new Error(`Duplicate work handler: ${kind}`);
    this.handlers.set(kind, handler);
  }

  @Cron('*/5 * * * * *')
  async drain() {
    // These four advisory slots bound active work across ALL API instances.
    await Promise.all(
      Array.from({ length: WORK_CONCURRENCY }, (_, slot) => this.runSlot(slot)),
    );
  }

  async runKey(key: string) {
    for (let slot = 0; slot < WORK_CONCURRENCY; slot++) {
      if (await this.runSlot(slot, key)) return;
    }
  }

  private async runSlot(slot: number, key?: string) {
    if (this.activeSlots.has(slot)) return;
    this.activeSlots.add(slot);
    try {
      return await withWorkGuard(this.prisma.postgresqlPool, async (guard) => {
        const {
          rows: [lock],
        } = await guard.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_xact_lock(61006, $1) AS locked',
          [slot],
        );
        if (!lock.locked) return;
        if (!this.handlers.size) return;
        const candidates = await this.prisma.$queryRaw<
          DurableWork[]
        >(Prisma.sql`
        SELECT * FROM durable_work WHERE kind IN (${Prisma.join([...this.handlers.keys()])})
        AND status IN ('PENDING','RUNNING')
        AND next_attempt_at <= timezone('UTC', clock_timestamp())
        AND (lease_until IS NULL OR lease_until < timezone('UTC', clock_timestamp()))
        ${key ? Prisma.sql`AND key=${key}` : Prisma.empty}
        ORDER BY next_attempt_at, key LIMIT 20`);
        for (const work of candidates) {
          // A live slow worker retains this lock even after its lease expires.
          const {
            rows: [jobLock],
          } = await guard.query<{ locked: boolean }>(
            'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS locked',
            [`exom:work:${work.key}`],
          );
          if (!jobLock.locked) continue;
          const token = randomUUID();
          const [claimed] = await this.prisma.$queryRaw<DurableWork[]>`
          UPDATE durable_work SET status='RUNNING', claim_token=${token},
            lease_until=timezone('UTC',clock_timestamp()) + interval '5 minutes', attempts=attempts+1
          WHERE key=${work.key} AND status IN ('PENDING','RUNNING')
            AND next_attempt_at<=timezone('UTC',clock_timestamp())
            AND (lease_until IS NULL OR lease_until<timezone('UTC',clock_timestamp()))
          RETURNING *`;
          if (!claimed) continue;
          const attempt = claimed.attempts;
          try {
            if (
              attempt > WORK_MAX_ATTEMPTS &&
              !(await this.acceptanceRecorded(claimed))
            )
              throw new PermanentWorkError('ATTEMPTS_EXHAUSTED');
            const handler = this.handlers.get(work.kind)!;
            await workContext.run(claimed, () => handler(claimed));
            await this.finish(work, token, 'DONE', null);
          } catch (error: unknown) {
            const terminal =
              error instanceof PermanentWorkError ||
              attempt >= WORK_MAX_ATTEMPTS;
            // Provider messages can contain tokens/PII. Persist only our error class.
            const code =
              error instanceof PermanentWorkError ||
              error instanceof RetryWorkError
                ? error.message
                : 'ATTEMPT_FAILED_OR_AMBIGUOUS';
            await this.finish(
              work,
              token,
              terminal ? 'FAILED' : 'PENDING',
              code,
              attempt,
            );
            this.logger.warn(
              `Durable work ${work.kind}: ${terminal ? 'FAILED' : 'RETRY'} (${code})`,
            );
          }
          return true; // One bounded unit per slot per tick; no unbounded drain loop.
        }
      });
    } finally {
      this.activeSlots.delete(slot);
    }
  }

  private async finish(
    work: DurableWork,
    token: string,
    status: string,
    error: string | null,
    attempt = 0,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const delay = Math.min(3600000, 5000 * 2 ** Math.max(0, attempt - 1));
      const result = await tx.$executeRaw`
        UPDATE durable_work SET status=${status},last_error=${error},claim_token=NULL,lease_until=NULL,
          next_attempt_at=timezone('UTC',clock_timestamp()) + ${delay} * interval '1 millisecond',
          completed_at=CASE WHEN ${status}='DONE' THEN timezone('UTC',clock_timestamp()) ELSE NULL END
        WHERE key=${work.key} AND claim_token=${token} AND status='RUNNING'`;
      if (result && work.kind === 'FCM' && status === 'FAILED') {
        await tx.notification.updateMany({
          where: { id: work.key, status: { not: 'SENT' } },
          data: { status: 'FAILED', error },
        });
      }
    });
  }

  private async acceptanceRecorded(work: DurableWork) {
    if (work.kind === 'FCM')
      return Boolean(
        await this.prisma.notification.findFirst({
          where: {
            id: work.key,
            status: 'SENT',
            provider_message_id: { not: null },
          },
          select: { id: true },
        }),
      );
    const payload = work.payload;
    return (
      work.kind === 'EMAIL' &&
      payload !== null &&
      typeof payload === 'object' &&
      !Array.isArray(payload) &&
      payload.accepted === true
    );
  }
}
