import { ConfigService } from '@nestjs/config';
import {
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  ManagedUploadPurpose,
  MediaType,
  PrismaClient,
  Role,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PrismaService } from '../../prisma/prisma.service';
import { withLiveUsers } from '../../common/user-external-effect';
import { UploadsService } from '../uploads/uploads.service';
import {
  ClientDeletionService,
  DeletionIdentityService,
} from './client-deletion.service';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('F004 deletion — real PostgreSQL, simulated Firebase/storage', () => {
  let pool: Pool;
  let prisma: PrismaClient;
  let service: ClientDeletionService;
  let uploads: UploadsService;
  let identity: DeletionIdentityService;
  let removeIdentity: jest.SpiedFunction<DeletionIdentityService['remove']>;
  let removeObject: jest.SpiedFunction<
    UploadsService['deleteAndVerifyForClientDeletion']
  >;
  let adminId: string;
  const users: string[] = [];
  const trainings: string[] = [];
  const diets: string[] = [];

  async function client(role: Role = Role.CLIENT) {
    const id = randomUUID();
    users.push(id);
    return prisma.user.create({
      data: {
        id,
        email: `${id}@example.test`,
        firebase_uid: `firebase-${id}`,
        role,
      },
    });
  }
  async function evidence(id: string) {
    const key = `feedback-video/${id}/${randomUUID()}.mp4`;
    const upload = await prisma.managedUpload.create({
      data: {
        owner_id: id,
        object_key: key,
        purpose: ManagedUploadPurpose.FEEDBACK_VIDEO,
        mime_type: 'video/mp4',
        expected_bytes: 12,
        expires_at: new Date(Date.now() + 86400000),
      },
    });
    await prisma.feedbackMedia.create({
      data: {
        client_id: id,
        client_upload_id: upload.id,
        media_type: MediaType.VIDEO,
        media_url: `r2://${key}`,
      },
    });
    return key;
  }
  async function due(id: string) {
    await prisma.clientDeletion.update({
      where: { id },
      data: { next_attempt_at: new Date(0) },
    });
  }
  beforeAll(async () => {
    const target = new URL(url!);
    if (
      target.hostname !== '127.0.0.1' ||
      target.port !== '55437' ||
      target.pathname !== '/exom_review'
    )
      throw new Error('Identified isolated DB required');
    pool = new Pool({
      connectionString: url,
      application_name: 'f004-deletion-test',
    });
    const result = await pool.query<{ data_directory: string }>(
      'SHOW data_directory',
    );
    if (
      !result.rows[0].data_directory
        .replaceAll('\\', '/')
        .endsWith('/EXOM/phase4-20260906/pgdata')
    )
      throw new Error('Unexpected cluster');
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  });
  beforeEach(async () => {
    identity = new DeletionIdentityService();
    removeIdentity = jest
      .spyOn(identity, 'remove')
      .mockResolvedValue(undefined);
    // PrismaClient is the tested transaction implementation; only Nest lifecycle
    // methods differ from PrismaService. No database methods are substituted.
    const database = prisma as PrismaService;
    uploads = new UploadsService(
      new ConfigService({
        NODE_ENV: 'test',
        R2_ENDPOINT: 'http://127.0.0.1:1',
      }),
      database,
    );
    removeObject = jest
      .spyOn(uploads, 'deleteAndVerifyForClientDeletion')
      .mockResolvedValue(undefined);
    // Only the identified simulation has a known completed transfer barrier.
    jest.spyOn(uploads, 'requiresDeletionDrainReview').mockReturnValue(false);
    service = new ClientDeletionService(database, uploads, identity);
    adminId = (await client(Role.SUPER_ADMIN)).id;
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.clientDeletion.deleteMany({
      where: { client_id: { in: users } },
    });
    await prisma.training.deleteMany({ where: { id: { in: trainings } } });
    await prisma.diet.deleteMany({ where: { id: { in: diets } } });
    users.length = 0;
    trainings.length = 0;
    diets.length = 0;
  });
  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
  });

  it('deletes the selected history and private inventory while preserving another client and shared catalog', async () => {
    const a = await client();
    const b = await client();
    const training = await prisma.training.create({
      data: { name: 'Shared fixture', type: 'STRENGTH', created_by: adminId },
    });
    trainings.push(training.id);
    const diet = await prisma.diet.create({
      data: { name: 'Shared diet fixture', created_by: adminId },
    });
    diets.push(diet.id);
    for (const owner of [a, b]) {
      await prisma.profile.create({
        data: { user_id: owner.id, first_name: 'Fixture', last_name: 'Client' },
      });
      await prisma.planAssignment.create({
        data: {
          client_id: owner.id,
          date: new Date('2026-09-01'),
          training_id: training.id,
          trainings: { create: { training_id: training.id, position: 0 } },
        },
      });
      await prisma.dayProgress.create({
        data: {
          client_id: owner.id,
          date: new Date('2026-09-01'),
          meals_completed: [],
          exercises_completed: [{ sets: [{ reps: 12, rir: 2, weight: 40 }] }],
        },
      });
      await prisma.planAssignment.create({
        data: {
          client_id: owner.id,
          date: new Date('2099-01-01'),
          diet_id: diet.id,
        },
      });
      await prisma.bodyMetric.create({
        data: {
          client_id: owner.id,
          date: new Date('2026-09-01'),
          weight_kg: 80,
        },
      });
      await prisma.streak.create({
        data: { client_id: owner.id, current_days: 3 },
      });
      await prisma.weeklyRecap.create({
        data: {
          client_id: owner.id,
          week_start_date: new Date('2026-09-01'),
          week_end_date: new Date('2026-09-07'),
          improvement_areas: [],
        },
      });
      await prisma.dietDaySnapshot.create({
        data: {
          client_id: owner.id,
          date: new Date('2026-09-01'),
          diet_id: diet.id,
          provenance: 'observed',
          diet: { meals: [] },
        },
      });
    }
    const key = await evidence(a.id);
    const op = await service.request(a.id, adminId);
    expect(op.status).toBe('PENDING');
    expect(removeIdentity).not.toHaveBeenCalled();
    expect(await prisma.user.findUnique({ where: { id: a.id } })).toBeNull();
    expect(await prisma.profile.count({ where: { user_id: a.id } })).toBe(0);
    expect(
      await prisma.feedbackMedia.count({ where: { client_id: a.id } }),
    ).toBe(0);
    expect(
      await prisma.managedUpload.count({ where: { owner_id: a.id } }),
    ).toBe(0);
    expect(
      await prisma.dietDaySnapshot.count({ where: { client_id: a.id } }),
    ).toBe(0);
    expect(await prisma.dayProgress.count({ where: { client_id: b.id } })).toBe(
      1,
    );
    expect(
      await prisma.dietDaySnapshot.count({ where: { client_id: b.id } }),
    ).toBe(1);
    expect(
      await prisma.training.findUnique({ where: { id: training.id } }),
    ).not.toBeNull();
    expect(
      await prisma.diet.findUnique({ where: { id: diet.id } }),
    ).not.toBeNull();
    expect(
      await prisma.planAssignment.count({
        where: { client_id: b.id, diet_id: diet.id },
      }),
    ).toBe(1);
    expect(await prisma.dayProgress.count({ where: { client_id: a.id } })).toBe(
      0,
    );
    expect(await prisma.bodyMetric.count({ where: { client_id: a.id } })).toBe(
      0,
    );
    expect(await prisma.weeklyRecap.count({ where: { client_id: a.id } })).toBe(
      0,
    );
    expect(
      (await prisma.clientDeletion.findUniqueOrThrow({ where: { id: op.id } }))
        .object_keys,
    ).toEqual([key]);
    await service.process(op.id);
    expect(removeObject).toHaveBeenCalledWith(key);
    expect(
      await prisma.clientDeletion.findUnique({ where: { id: op.id } }),
    ).toMatchObject({
      status: 'COMPLETED',
      object_keys: [],
      firebase_uid: a.firebase_uid,
    });
  });

  it('rejects ordinary ADMIN, another owner, and deletion of an administrator', async () => {
    const a = await client();
    const ordinary = await client(Role.ADMIN);
    await expect(service.request(a.id, ordinary.id)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.request(ordinary.id, adminId)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      service.request(a.id, ordinary.id, true),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(await prisma.user.count({ where: { id: a.id } })).toBe(1);
  });

  it('deduplicates simultaneous requests and replay after a lost response', async () => {
    const a = await client();
    const [one, two] = await Promise.all([
      service.request(a.id, adminId),
      service.request(a.id, adminId),
    ]);
    expect(one.id).toBe(two.id);
    await service.process(one.id);
    expect(await service.request(a.id, adminId)).toMatchObject({
      id: one.id,
      status: 'COMPLETED',
    });
    expect(removeIdentity).toHaveBeenCalledTimes(1);
  });

  it.each(['before-external', 'after-external'])(
    'recovers abandoned claim after crash %s',
    async (stage) => {
      const a = await client();
      const key = await evidence(a.id);
      const op = await service.request(a.id, adminId);
      if (stage === 'after-external') {
        await identity.remove(a.firebase_uid);
        await uploads.deleteAndVerifyForClientDeletion(key);
      }
      await prisma.clientDeletion.update({
        where: { id: op.id },
        data: {
          status: 'PROCESSING',
          claimed_at: new Date(Date.now() - 360000),
          claim_token: randomUUID(),
        },
      });
      await service.recover();
      expect(await service.get(op.id)).toMatchObject({ status: 'COMPLETED' });
      expect(removeObject).toHaveBeenLastCalledWith(key);
    },
  );

  it.each(['identity', 'storage'])(
    'retains inventory on %s failure and retries automatically with backoff',
    async (stage) => {
      const a = await client();
      const key = await evidence(a.id);
      const op = await service.request(a.id, adminId);
      (stage === 'identity'
        ? removeIdentity
        : removeObject
      ).mockRejectedValueOnce(new Error('simulated response lost'));
      await service.process(op.id);
      expect(
        await prisma.clientDeletion.findUnique({ where: { id: op.id } }),
      ).toMatchObject({
        status: 'PENDING',
        object_keys: [key],
        last_error: 'EXTERNAL_CLEANUP_PENDING',
      });
      await service.recover();
      expect(await service.get(op.id)).toMatchObject({ attempts: 1 });
      await due(op.id);
      await service.recover();
      expect(await service.get(op.id)).toMatchObject({
        status: 'COMPLETED',
        attempts: 2,
      });
    },
  );

  it('does not allow two workers to consume a live claim', async () => {
    const a = await client();
    const op = await service.request(a.id, adminId);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    removeIdentity.mockImplementationOnce(async () => {
      entered();
      await gate;
    });
    const running = service.process(op.id);
    await started;
    try {
      await service.process(op.id);
      expect(removeIdentity).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await running;
    }
    expect(await service.get(op.id)).toMatchObject({ status: 'COMPLETED' });
  });

  it('waits for an in-flight external writer; rejects writers and replay after deletion', async () => {
    const a = await client();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writing = withLiveUsers(prisma as PrismaService, [a.id], async () => {
      entered();
      await gate;
    });
    await started;
    const deletion = service.request(a.id, adminId);
    try {
      let blocked = false;
      for (let n = 0; n < 100; n++) {
        const locks = await pool.query<{ waiting: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = 'f004-deletion-test' AND wait_event_type = 'Lock') AS waiting",
        );
        if (locks.rows[0].waiting) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
    } finally {
      release();
      await writing;
      await deletion;
    }
    const effect = jest.fn<Promise<void>, []>();
    await expect(
      withLiveUsers(prisma as PrismaService, [a.id], effect),
    ).rejects.toThrow();
    expect(effect).not.toHaveBeenCalled();
    await expect(
      prisma.dayProgress.create({
        data: { client_id: a.id, date: new Date(), meals_completed: [] },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.user.create({
        data: { id: a.id, email: a.email, firebase_uid: a.firebase_uid },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.notification.create({
        data: {
          sender_id: adminId,
          recipient_id: adminId,
          title: 'Late',
          body: 'Fixture',
          data: { nested: { client_id: a.id } },
        },
      }),
    ).rejects.toThrow();
  });

  it('blocks ambiguous legacy media without deleting database data', async () => {
    const a = await client();
    await prisma.profile.create({
      data: {
        user_id: a.id,
        first_name: 'Fixture',
        last_name: '',
        avatar_url: 'https://unknown.example/shared.jpg',
      },
    });
    await expect(service.request(a.id, adminId)).rejects.toMatchObject({
      response: { code: 'DELETION_OWNERSHIP_REVIEW' },
    });
    expect(await prisma.user.count({ where: { id: a.id } })).toBe(1);
    expect(
      await prisma.clientDeletion.count({ where: { client_id: a.id } }),
    ).toBe(0);
  });

  it('retains the journal for direct PUT drain review, including a late recreated object', async () => {
    const a = await client();
    const key = await evidence(a.id);
    jest.spyOn(uploads, 'requiresDeletionDrainReview').mockReturnValue(true);
    const op = await service.request(a.id, adminId);
    await service.process(op.id);
    expect(await service.get(op.id)).toMatchObject({
      status: 'BLOCKED',
      last_error: 'UPLOAD_DRAIN_REVIEW_REQUIRED',
      completed_at: null,
    });
    // A second cleanup must still know the key after the original object was
    // deleted. This models late arrival; it does not prove R2's drain contract.
    await due(op.id);
    await service.recover();
    expect(removeObject.mock.calls).toEqual([[key], [key]]);
    expect(
      (await prisma.clientDeletion.findUniqueOrThrow({ where: { id: op.id } }))
        .object_keys,
    ).toEqual([key]);
  });

  it('self-delete shares the durable operation and never returns 2xx completion on external failure', async () => {
    const a = await client();
    removeIdentity.mockRejectedValueOnce(new Error('unavailable'));
    await expect(service.deleteSelf(a.id)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    const op = await prisma.clientDeletion.findUniqueOrThrow({
      where: { client_id: a.id },
    });
    expect(op.status).toBe('PENDING');
    await due(op.id);
    await service.recover();
    expect(await service.get(op.id)).toMatchObject({ status: 'COMPLETED' });
  });
  it('preserves existing self-delete authorization without exposing administrator deletion through the admin endpoint', async () => {
    const actor = await client(Role.ADMIN);
    await expect(service.request(actor.id, adminId)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.deleteSelf(actor.id)).resolves.toEqual({
      success: true,
    });
  });

  it('rejects binding a completed deletion identity to a new EXOM account', async () => {
    const old = await client();
    const operation = await service.request(old.id, adminId);
    await service.process(operation.id);
    const next = await client();
    await expect(
      prisma.user.update({
        where: { id: next.id },
        data: { firebase_uid: old.firebase_uid },
      }),
    ).rejects.toThrow();
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: next.id } }))
        .firebase_uid,
    ).toBe(next.firebase_uid);
  });

  it('fences Firebase UID reuse while the old owner deletion is uncommitted', async () => {
    const a = await client();
    const newId = randomUUID();
    users.push(newId);
    const writer = await pool.connect();
    await writer.query('BEGIN');
    await writer.query(
      'INSERT INTO client_deletions(id,client_id,requested_by,firebase_uid,object_keys) VALUES($1,$2,$3,$4,$5)',
      [randomUUID(), a.id, adminId, a.firebase_uid, []],
    );
    await writer.query('DELETE FROM users WHERE id=$1', [a.id]);
    const creating = prisma.user
      .create({
        data: {
          id: newId,
          email: newId + '@example.test',
          firebase_uid: a.firebase_uid,
        },
      })
      .then(
        () => ({ accepted: true }),
        () => ({ accepted: false }),
      );
    try {
      let blocked = false;
      for (let n = 0; n < 100; n++) {
        const locks = await pool.query<{ waiting: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = 'f004-deletion-test' AND wait_event_type = 'Lock') AS waiting",
        );
        if (locks.rows[0].waiting) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
    } finally {
      await writer.query('COMMIT');
      writer.release();
    }
    expect(await creating).toEqual({ accepted: false });
    expect(await prisma.user.count({ where: { id: newId } })).toBe(0);
  });
});
