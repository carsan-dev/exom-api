import { ConfigService } from '@nestjs/config';
import { PrismaClient, Role } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListPartsCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { PrismaService } from '../../prisma/prisma.service';
import { MultipartTransfer } from './multipart-transfer';
import { UploadsService } from './uploads.service';
import {
  ClientDeletionService,
  DeletionIdentityService,
} from '../client-deletion/client-deletion.service';

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)(
  'ISSUE-057 durable multipart with real PostgreSQL and explicit remote simulation',
  () => {
    let pool: Pool, db: PrismaClient, service: MultipartTransfer, s3: S3Client;
    const owners: string[] = [];
    const remote = new Map<
      string,
      { id: string; part: boolean; object: boolean; aborted: boolean }
    >();
    let lost: string | null;
    let beforeCreate: (() => Promise<void>) | undefined;
    const calls: string[] = [];
    const originalSendDescriptor = Object.getOwnPropertyDescriptor(
      S3Client.prototype,
      'send',
    );
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=',
      'base64',
    );
    const missing = (name: string) =>
      Object.assign(new Error(name), {
        name,
        $metadata: { httpStatusCode: 404 },
      });
    async function transfer(protocol = 'MULTIPART', state = 'NEW') {
      const owner = randomUUID(),
        id = randomUUID();
      owners.push(owner);
      await db.user.create({
        data: {
          id: owner,
          email: `${owner}@example.test`,
          firebase_uid: owner,
          role: Role.CLIENT,
        },
      });
      return db.uploadTransfer.create({
        data: {
          id,
          owner_id: owner,
          object_key: `feedback-image/${owner}/${id}.png`,
          protocol,
          state,
        },
      });
    }
    beforeAll(async () => {
      const target = new URL(url!);
      if (
        target.hostname !== '127.0.0.1' ||
        !['55437', '55447'].includes(target.port) ||
        target.pathname !== '/exom_review'
      )
        throw Error('ISOLATED_DB_REQUIRED');
      pool = new Pool({
        connectionString: url,
        application_name: 'multipart-057',
      });
      const identity = (
        await pool.query<{ directory: string }>(
          "SELECT current_setting('data_directory') AS directory",
        )
      ).rows[0];
      if (
        ![
          '/EXOM/phase4-20260906/pgdata',
          '/EXOM/docs/operations/phase6-20260911/pgdata',
          '/EXOM/docs/operations/phase7-20260912/pgdata',
        ].some((directory) =>
          identity.directory.replaceAll('\\', '/').endsWith(directory),
        )
      )
        throw Error('WRONG_CLUSTER');
      db = new PrismaClient({ adapter: new PrismaPg(pool) });
    });
    beforeEach(() => {
      lost = null;
      beforeCreate = undefined;
      calls.length = 0;
      s3 = new S3Client({
        region: 'auto',
        endpoint: 'https://storage.example.test',
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      });
      const simulate = jest.fn<Promise<unknown>, [unknown]>(async (command) => {
        if (!(command instanceof Object)) throw Error('INVALID_COMMAND');
        calls.push(command.constructor.name);
        const responseLost = () => {
          if (lost === command.constructor.name) {
            lost = null;
            throw Error('SIMULATED_RESPONSE_LOST');
          }
        };
        if (command instanceof CreateMultipartUploadCommand) {
          await beforeCreate?.();
          const id = randomUUID();
          remote.set(command.input.Key!, {
            id,
            part: false,
            object: false,
            aborted: false,
          });
          responseLost();
          return { $metadata: {}, UploadId: id };
        }
        if (command instanceof ListMultipartUploadsCommand) {
          return {
            $metadata: {},
            Uploads: [...remote.entries()]
              .filter(
                ([key, value]) =>
                  key === command.input.Prefix &&
                  !value.aborted &&
                  !value.object,
              )
              .map(([Key, value]) => ({ Key, UploadId: value.id })),
          };
        }
        if (command instanceof GetObjectCommand) {
          if (!remote.get(command.input.Key!)?.object)
            throw missing('NotFound');
          return {
            $metadata: {},
            Body: {
              transformToByteArray: () => Promise.resolve(png.subarray(0, 32)),
            },
          };
        }
        if (
          command instanceof UploadPartCommand ||
          command instanceof ListPartsCommand ||
          command instanceof CompleteMultipartUploadCommand ||
          command instanceof AbortMultipartUploadCommand ||
          command instanceof HeadObjectCommand
        ) {
          const stored = remote.get(command.input.Key!);
          if (command instanceof HeadObjectCommand) {
            if (!stored?.object) throw missing('NotFound');
            return {
              $metadata: {},
              ContentLength: 68,
              ContentType: 'image/png',
            };
          }
          if (command instanceof AbortMultipartUploadCommand) {
            if (stored) stored.aborted = true;
            responseLost();
            return { $metadata: {} };
          }
          if (!stored || stored.aborted || stored.object)
            throw missing('NoSuchUpload');
          if (command instanceof ListPartsCommand)
            return {
              $metadata: {},
              Parts: stored.part
                ? [{ PartNumber: 1, ETag: 'etag', Size: 68 }]
                : [],
            };
          if (command instanceof UploadPartCommand) stored.part = true;
          if (command instanceof CompleteMultipartUploadCommand)
            stored.object = true;
          responseLost();
          return { $metadata: {}, ETag: 'etag' };
        }
        throw Error('UNEXPECTED_REMOTE_COMMAND');
      });
      // Stub the Promise form used by the application; Jest's spy type selects
      // the SDK's unrelated callback/void overload. Restore the exact descriptor.
      Object.defineProperty(S3Client.prototype, 'send', {
        value: simulate,
        configurable: true,
        writable: true,
      });
      service = new MultipartTransfer(
        db as PrismaService,
        s3,
        'isolated-simulation',
      );
    });
    afterEach(async () => {
      jest.restoreAllMocks();
      if (originalSendDescriptor)
        Object.defineProperty(
          S3Client.prototype,
          'send',
          originalSendDescriptor,
        );
      else Reflect.deleteProperty(S3Client.prototype, 'send');
      s3.destroy();
      remote.clear();
      await db.user.deleteMany({ where: { id: { in: owners } } });
      await db.clientDeletion.deleteMany({
        where: { client_id: { in: owners } },
      });
      await db.uploadTransfer.deleteMany({
        where: { owner_id: { in: owners } },
      });
    });
    afterAll(async () => {
      await db.$disconnect();
      await pool.end();
    });

    it('keeps the previous Flutter sequence, avatar contract and lost completion reconciliation', async () => {
      const owner = await transfer('LOCAL');
      const uploads = new UploadsService(
        new ConfigService({
          NODE_ENV: 'production',
          R2_BUCKET_NAME: 'isolated-simulation',
          R2_ENDPOINT: 'https://storage.example.test',
          R2_ACCESS_KEY_ID: 'test',
          R2_SECRET_ACCESS_KEY: 'test',
        }),
        db as PrismaService,
      );
      const request = {
        purpose: 'AVATAR' as const,
        mimeType: 'image/png',
        bytes: 68,
        clientOperationId: 'avatar:0',
      };
      const session = await uploads.createSession(
        owner.owner_id,
        Role.CLIENT,
        request,
      );
      expect(session).toMatchObject({ transport: 'direct' });
      expect(typeof session.upload_id).toBe('string');
      expect('upload_url' in session && session.upload_url).toContain(
        'partNumber=1',
      );
      await expect(
        uploads.completeSession(owner.owner_id, session.upload_id),
      ).rejects.toMatchObject({ response: { code: 'UPLOAD_OBJECT_MISSING' } });
      const receipt = await db.uploadTransfer.findUniqueOrThrow({
        where: { id: session.upload_id },
      });
      expect(receipt.protocol).toBe('MULTIPART');
      await uploads.uploadFile(png, receipt.object_key!, 'image/png');
      lost = 'CompleteMultipartUploadCommand';
      await expect(
        uploads.completeSession(owner.owner_id, session.upload_id),
      ).rejects.toThrow('SIMULATED_RESPONSE_LOST');
      const retry = await uploads.createSession(
        owner.owner_id,
        Role.CLIENT,
        request,
      );
      expect(retry.upload_id).toBe(session.upload_id);
      expect(retry).not.toHaveProperty('upload_url');
      await expect(
        uploads.completeSession(owner.owner_id, session.upload_id),
      ).resolves.toMatchObject({ status: 'VERIFIED', bytes: 68 });
      expect(
        calls.filter((c) => c === 'CompleteMultipartUploadCommand'),
      ).toHaveLength(1);
    });

    it('rolls legacy missing content to a new persisted client generation without emitting direct PUT', async () => {
      const owner = await transfer('LOCAL');
      const legacy = await db.managedUpload.create({
        data: {
          owner_id: owner.owner_id,
          object_key: `feedback-image/${owner.owner_id}/${randomUUID()}.png`,
          mime_type: 'image/png',
          expected_bytes: 68,
          purpose: 'FEEDBACK_IMAGE',
          client_operation_id: 'old:0',
          expires_at: new Date(Date.now() + 60000),
        },
      });
      const uploads = new UploadsService(
        new ConfigService({
          NODE_ENV: 'production',
          R2_ENDPOINT: 'https://storage.example.test',
        }),
        db as PrismaService,
      );
      const recovered = await uploads.createSession(
        owner.owner_id,
        Role.CLIENT,
        {
          purpose: 'FEEDBACK_IMAGE',
          mimeType: 'image/png',
          bytes: 68,
          clientOperationId: 'old:0',
        },
      );
      expect(recovered.upload_id).toBe(legacy.id);
      expect(recovered).not.toHaveProperty('upload_url');
      await expect(
        uploads.completeSession(owner.owner_id, legacy.id),
      ).rejects.toMatchObject({ response: { code: 'UPLOAD_EXPIRED' } });
      expect(
        await db.uploadTransfer.findUnique({ where: { id: legacy.id } }),
      ).toMatchObject({ protocol: 'DIRECT', state: 'UNCERTAIN' });
      expect(calls).not.toContain('CreateMultipartUploadCommand');
    });

    it('can finish a known multipart deletion automatically and retries a lost DELETE response', async () => {
      const row = await transfer();
      await service.put(row.id, 'image/png', png, png.length);
      await service.publish(row.id);
      const uploads = new UploadsService(
        new ConfigService({
          NODE_ENV: 'production',
          R2_ENDPOINT: 'https://storage.example.test',
          R2_BUCKET_NAME: 'isolated-simulation',
        }),
        db as PrismaService,
      );
      jest
        .spyOn(uploads, 'discoverForClientDeletion')
        .mockImplementation(() =>
          Promise.resolve(
            remote.get(row.object_key!)?.object ? [row.object_key!] : [],
          ),
        );
      let lostDelete = true;
      jest
        .spyOn(uploads, 'deleteAndVerifyForClientDeletion')
        .mockImplementation(() => {
          const value = remote.get(row.object_key!)!;
          expect(value.aborted).toBe(true);
          value.object = false;
          if (lostDelete) {
            lostDelete = false;
            return Promise.reject(Error('DELETE_RESPONSE_LOST'));
          }
          return Promise.resolve();
        });
      jest.spyOn(uploads, 'credentialLifetimeMs').mockReturnValue(0);
      const identity = new DeletionIdentityService();
      jest.spyOn(identity, 'credentialLifetimeMs').mockReturnValue(0);
      jest.spyOn(identity, 'remove').mockResolvedValue();
      jest.spyOn(identity, 'isAbsent').mockResolvedValue(true);
      const deletion = new ClientDeletionService(
        db as PrismaService,
        uploads,
        identity,
      );
      const op = await deletion.request(row.owner_id, row.owner_id, true);
      await deletion.process(op.id);
      expect(await deletion.get(op.id)).toMatchObject({
        status: 'PENDING',
        last_error: 'STORAGE_CLEANUP_PENDING',
      });
      await db.clientDeletion.update({
        where: { id: op.id },
        data: { next_attempt_at: new Date(0) },
      });
      await deletion.process(op.id);
      expect(await deletion.get(op.id)).toMatchObject({ status: 'COMPLETED' });
      expect(
        calls.filter((c) => c === 'CompleteMultipartUploadCommand'),
      ).toHaveLength(1);
    });

    it('persists CREATE before sending, recovers a lost response without creating again', async () => {
      const row = await transfer();
      lost = 'CreateMultipartUploadCommand';
      beforeCreate = async () => {
        expect(
          await db.uploadTransfer.findUnique({ where: { id: row.id } }),
        ).toMatchObject({ state: 'CREATING', external_pending: 'CREATE' });
      };
      await expect(service.signedPart(row.id, 'image/png', 60)).rejects.toThrow(
        'SIMULATED_RESPONSE_LOST',
      );
      await expect(
        service.signedPart(row.id, 'image/png', 60),
      ).resolves.toContain('partNumber=1');
      expect(
        calls.filter((c) => c === 'CreateMultipartUploadCommand'),
      ).toHaveLength(1);
    });
    it('retains uncertainty when a crashed CREATE has no visible upload', async () => {
      const row = await transfer('MULTIPART', 'CREATING');
      await expect(
        service.signedPart(row.id, 'image/png', 60),
      ).rejects.toMatchObject({
        response: { code: 'UPLOAD_TRANSFER_PENDING' },
      });
      expect(await service.cancel(row.id)).toBe(false);
      expect(await service.cancel(row.id)).toBe(false);
      expect(calls).not.toContain('CreateMultipartUploadCommand');
      expect(
        await db.uploadTransfer.findUnique({ where: { id: row.id } }),
      ).toMatchObject({ state: 'CREATING', cancel_requested: true });
    });

    it('persists recovered IDs before abort when both CREATE and ABORT responses are lost', async () => {
      const row = await transfer();
      lost = 'CreateMultipartUploadCommand';
      await expect(service.signedPart(row.id, 'image/png', 60)).rejects.toThrow(
        'SIMULATED_RESPONSE_LOST',
      );
      lost = 'AbortMultipartUploadCommand';
      await expect(service.cancel(row.id)).rejects.toThrow(
        'SIMULATED_RESPONSE_LOST',
      );
      const uncertain = await db.uploadTransfer.findUniqueOrThrow({
        where: { id: row.id },
      });
      expect(uncertain.multipart_id).toBeNull();
      expect(uncertain.recovery_ids).toHaveLength(1);
      expect(await service.cancel(row.id)).toBe(true);
    });

    it('recovers after losing the advisory-lock connection while CREATE is in flight', async () => {
      const row = await transfer();
      let release!: () => void, entered!: () => void;
      const held = new Promise<void>((r) => {
        release = r;
      });
      const ready = new Promise<void>((r) => {
        entered = r;
      });
      beforeCreate = async () => {
        entered();
        await held;
      };
      const first = service.signedPart(row.id, 'image/png', 60).then(
        () => 'URL',
        () => 'RECOVERABLE_ERROR',
      );
      await ready;
      const locks = await pool.query<{ pid: number }>(
        "SELECT DISTINCT a.pid FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid WHERE a.application_name='multipart-057' AND l.locktype='advisory' AND l.granted",
      );
      expect(locks.rows).toHaveLength(1);
      await pool.query('SELECT pg_terminate_backend($1)', [locks.rows[0].pid]);
      let cancelled: boolean;
      try {
        cancelled = await service.cancel(row.id);
      } finally {
        release();
      }
      expect(cancelled).toBe(false);
      expect(await first).toBe('RECOVERABLE_ERROR');
      expect(await service.cancel(row.id)).toBe(true);
      expect(remote.get(row.object_key!)?.aborted).toBe(true);
    });
    it('preserves early complete as UPLOAD_OBJECT_MISSING and later publishes once', async () => {
      const row = await transfer();
      await service.signedPart(row.id, 'image/png', 60);
      await expect(service.publish(row.id)).rejects.toMatchObject({
        response: { code: 'UPLOAD_OBJECT_MISSING' },
      });
      expect(
        await db.uploadTransfer.findUnique({ where: { id: row.id } }),
      ).toMatchObject({ state: 'UPLOADING' });
      await service.put(row.id, 'image/png', Buffer.alloc(68), 68);
      await Promise.all([service.publish(row.id), service.publish(row.id)]);
      expect(
        calls.filter((c) => c === 'CompleteMultipartUploadCommand'),
      ).toHaveLength(1);
    });
    it('recovers completion response loss by HEAD, without publishing again', async () => {
      const row = await transfer();
      await service.put(row.id, 'image/png', Buffer.alloc(68), 68);
      lost = 'CompleteMultipartUploadCommand';
      await expect(service.publish(row.id)).rejects.toThrow(
        'SIMULATED_RESPONSE_LOST',
      );
      expect(
        await db.uploadTransfer.findUnique({ where: { id: row.id } }),
      ).toMatchObject({
        state: 'COMPLETING',
        external_pending: 'COMPLETE',
        etag: 'etag',
      });
      await service.publish(row.id);
      expect(
        calls.filter((c) => c === 'CompleteMultipartUploadCommand'),
      ).toHaveLength(1);
    });
    it('retries an unacknowledged abort and keeps cancellation durable across user cascade', async () => {
      const row = await transfer();
      await service.put(row.id, 'image/png', Buffer.alloc(68), 68);
      await db.user.delete({ where: { id: row.owner_id } });
      lost = 'AbortMultipartUploadCommand';
      await expect(service.cancelOwner(row.owner_id)).rejects.toThrow(
        'SIMULATED_RESPONSE_LOST',
      );
      expect(
        await db.uploadTransfer.findUnique({ where: { id: row.id } }),
      ).toMatchObject({ cancel_requested: true, external_pending: 'ABORT' });
      expect(await service.cancelOwner(row.owner_id)).toBe(true);
      await expect(
        service.signedPart(row.id, 'image/png', 60),
      ).rejects.toMatchObject({ response: { code: 'UPLOAD_EXPIRED' } });
      await expect(service.publish(row.id)).rejects.toMatchObject({
        response: { code: 'UPLOAD_TRANSFER_PENDING' },
      });
    });
    it('serializes duplicate create and cancel with an observed PostgreSQL wait', async () => {
      const row = await transfer();
      let release!: () => void, entered!: () => void;
      const held = new Promise<void>((r) => {
        release = r;
      });
      const ready = new Promise<void>((r) => {
        entered = r;
      });
      beforeCreate = async () => {
        entered();
        await held;
      };
      const first = service.signedPart(row.id, 'image/png', 60);
      await ready;
      const cancel = service.cancel(row.id);
      let waiting = 0;
      try {
        for (let i = 0; i < 100 && !waiting; i++) {
          waiting = (
            await pool.query<{ n: number }>(
              "SELECT count(*)::int n FROM pg_stat_activity WHERE application_name='multipart-057' AND cardinality(pg_blocking_pids(pid))>0",
            )
          ).rows[0].n;
          if (!waiting) await new Promise((r) => setTimeout(r, 10));
        }
      } finally {
        release();
      }
      await first;
      expect(await cancel).toBe(true);
      expect(waiting).toBeGreaterThan(0);
      expect(remote.get(row.object_key!)?.aborted).toBe(true);
    });
    it('keeps legacy deletion pending even after expiry and an empty remote inventory', async () => {
      const row = await transfer('DIRECT', 'UNCERTAIN');
      const uploads = new UploadsService(
        new ConfigService({ NODE_ENV: 'test' }),
        db as PrismaService,
      );
      jest.spyOn(uploads, 'discoverForClientDeletion').mockResolvedValue([]);
      jest
        .spyOn(uploads, 'deleteAndVerifyForClientDeletion')
        .mockResolvedValue();
      jest.spyOn(uploads, 'credentialLifetimeMs').mockReturnValue(0);
      const identity = new DeletionIdentityService();
      jest.spyOn(identity, 'credentialLifetimeMs').mockReturnValue(0);
      jest.spyOn(identity, 'remove').mockResolvedValue();
      jest.spyOn(identity, 'isAbsent').mockResolvedValue(true);
      const deletion = new ClientDeletionService(
        db as PrismaService,
        uploads,
        identity,
      );
      const op = await deletion.request(row.owner_id, row.owner_id, true);
      await deletion.process(op.id);
      expect(await deletion.get(op.id)).toMatchObject({
        status: 'PENDING',
        completed_at: null,
        last_error: 'STORAGE_TRANSFER_PENDING',
      });
      expect(
        await db.uploadTransfer.findUnique({ where: { id: row.id } }),
      ).not.toBeNull();
      await db.clientDeletion.update({
        where: { id: op.id },
        data: {
          status: 'COMPLETED',
          completed_at: new Date(),
          next_attempt_at: new Date(0),
        },
      });
      await deletion.process(op.id);
      expect(await deletion.get(op.id)).toMatchObject({
        status: 'PENDING',
        completed_at: null,
        last_error: 'STORAGE_TRANSFER_PENDING',
      });
    });
    it('allows automatic closure for a new owner with no legacy capabilities', async () => {
      const row = await transfer('LOCAL');
      const uploads = new UploadsService(
        new ConfigService({ NODE_ENV: 'test' }),
        db as PrismaService,
      );
      jest.spyOn(uploads, 'discoverForClientDeletion').mockResolvedValue([]);
      jest
        .spyOn(uploads, 'deleteAndVerifyForClientDeletion')
        .mockResolvedValue();
      jest.spyOn(uploads, 'credentialLifetimeMs').mockReturnValue(0);
      const identity = new DeletionIdentityService();
      jest.spyOn(identity, 'credentialLifetimeMs').mockReturnValue(0);
      jest.spyOn(identity, 'remove').mockResolvedValue();
      jest.spyOn(identity, 'isAbsent').mockResolvedValue(true);
      const deletion = new ClientDeletionService(
        db as PrismaService,
        uploads,
        identity,
      );
      const op = await deletion.request(row.owner_id, row.owner_id, true);
      await deletion.process(op.id);
      expect(await deletion.get(op.id)).toMatchObject({ status: 'COMPLETED' });
    });
  },
);
