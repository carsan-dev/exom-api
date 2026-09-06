import { PrismaPg } from '@prisma/adapter-pg';
import {
  ManagedUploadPurpose,
  ManagedUploadStatus,
  MediaType,
  PrismaClient,
  Role,
} from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { PrismaService } from '../../prisma/prisma.service';
import { FeedbackService } from '../feedback/feedback.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { UploadsService } from './uploads.service';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite('P4 upload identity and feedback PostgreSQL races', () => {
  const id = 'p4-upload-' + process.pid + '-' + Date.now();
  let first: PrismaClient;
  let second: PrismaClient;
  let pool: Pool;
  let otherPool: Pool;
  let uploads: UploadsService;
  let otherUploads: UploadsService;
  beforeAll(async () => {
    const target = new URL(url!);
    if (target.hostname !== '127.0.0.1' || target.pathname !== '/exom_review')
      throw new Error('Isolated local test database required');
    pool = new Pool({ connectionString: url, application_name: id + '-one' });
    otherPool = new Pool({
      connectionString: url,
      application_name: id + '-two',
    });
    first = new PrismaClient({ adapter: new PrismaPg(pool) });
    second = new PrismaClient({ adapter: new PrismaPg(otherPool) });
    const config = new ConfigService({
      NODE_ENV: 'test',
      R2_ENDPOINT: 'https://storage.exom.test',
      R2_BUCKET_NAME: 'test',
    });
    uploads = new UploadsService(config, first as PrismaService);
    otherUploads = new UploadsService(config, second as PrismaService);
    await first.user.create({
      data: { id, email: id + '@example.test', firebase_uid: id },
    });
  });
  afterAll(async () => {
    await first?.user.deleteMany({ where: { id } });
    await first?.$disconnect();
    await second?.$disconnect();
    await pool?.end();
    await otherPool?.end();
  });
  it('simultaneous session creation and a lost response preserve one upload identity', async () => {
    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [id]);
    const request = {
      purpose: ManagedUploadPurpose.FEEDBACK_VIDEO,
      mimeType: 'video/mp4',
      bytes: 12,
      clientOperationId: 'stable:0',
    };
    const work = Promise.all([
      uploads.createSession(id, Role.CLIENT, request),
      otherUploads.createSession(id, Role.CLIENT, request),
    ]);
    let waiting = 0;
    try {
      for (let n = 0; n < 200 && waiting < 2; n++) {
        await blocker.query('SELECT pg_stat_clear_snapshot()');
        const result = await blocker.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name LIKE $1 AND cardinality(pg_blocking_pids(pid))>0',
          [id + '-%'],
        );
        waiting = result.rows[0].n;
        if (waiting < 2)
          await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      await blocker.query('COMMIT');
      blocker.release();
    }
    const [a, b] = await work;
    expect(waiting).toBe(2);
    expect(a.upload_id).toBe(b.upload_id);
    expect(
      (await uploads.createSession(id, Role.CLIENT, request)).upload_id,
    ).toBe(a.upload_id);
    expect(await first.managedUpload.count({ where: { owner_id: id } })).toBe(
      1,
    );
    await expect(
      uploads.createSession(id, Role.CLIENT, { ...request, bytes: 13 }),
    ).rejects.toMatchObject({
      response: { code: 'UPLOAD_OPERATION_CONFLICT' },
    });
  });
  it('two feedback consumers of one upload both recover the one committed feedback', async () => {
    const session = await uploads.createSession(id, Role.CLIENT, {
      purpose: ManagedUploadPurpose.FEEDBACK_VIDEO,
      mimeType: 'video/mp4',
      bytes: 12,
      clientOperationId: 'feedback:0',
    });
    await first.managedUpload.update({
      where: { id: session.upload_id },
      data: {
        status: ManagedUploadStatus.VERIFIED,
        actual_bytes: 12,
        verified_at: new Date(),
      },
    });
    // No assigned admins: the real notification lookup produces no external send.
    const notify = jest.fn();
    const notifications = {
      sendInternalTemplate: notify,
    } as unknown as NotificationsService;
    const one = new FeedbackService(
      first as PrismaService,
      notifications,
      uploads,
    );
    const two = new FeedbackService(
      second as PrismaService,
      notifications,
      otherUploads,
    );
    const dto = {
      media_type: MediaType.VIDEO,
      upload_id: session.upload_id,
      client_upload_id: 'stable-feedback',
    };
    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query(
      'SELECT id FROM managed_uploads WHERE id=$1 FOR UPDATE',
      [session.upload_id],
    );
    const work = Promise.all([one.create(id, dto), two.create(id, dto)]);
    let waiting = 0;
    try {
      for (let n = 0; n < 200 && waiting < 2; n++) {
        await blocker.query('SELECT pg_stat_clear_snapshot()');
        const result = await blocker.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name LIKE $1 AND cardinality(pg_blocking_pids(pid))>0',
          [id + '-%'],
        );
        waiting = result.rows[0].n;
        if (waiting < 2)
          await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      await blocker.query('COMMIT');
      blocker.release();
    }
    const results: unknown[] = await work;
    expect(waiting).toBe(2);
    const feedbackId = (value: unknown): string => {
      if (
        !value ||
        typeof value !== 'object' ||
        !('id' in value) ||
        typeof value.id !== 'string'
      )
        throw new Error('Invalid feedback response');
      return value.id;
    };
    const [a, b] = results.map(feedbackId);
    expect(a).toBe(b);
    expect(feedbackId(await two.create(id, dto))).toBe(a);
    expect(await first.feedbackMedia.count({ where: { client_id: id } })).toBe(
      1,
    );
    expect(
      (
        await first.managedUpload.findUniqueOrThrow({
          where: { id: session.upload_id },
        })
      ).status,
    ).toBe(ManagedUploadStatus.CONSUMED);
    expect(notify).not.toHaveBeenCalled();
  });
});
