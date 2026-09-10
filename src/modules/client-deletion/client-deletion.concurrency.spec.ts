import { ConfigService } from '@nestjs/config';
import {
  ConflictException,
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
import { UsersService } from '../users/users.service';
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
    // This isolated fixture has no previously minted Firebase credentials.
    jest.spyOn(identity, 'credentialLifetimeMs').mockReturnValue(0);
    jest.spyOn(identity, 'isAbsent').mockResolvedValue(true);
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
    jest.spyOn(uploads, 'credentialLifetimeMs').mockReturnValue(0);
    jest.spyOn(uploads, 'discoverForClientDeletion').mockResolvedValue([]);
    service = new ClientDeletionService(database, uploads, identity);
    adminId = (await client(Role.SUPER_ADMIN)).id;
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.clientDeletion.deleteMany({
      where: { client_id: { in: users } },
    });
    await prisma.identityOperation.deleteMany({
      where: { user_id: { in: users } },
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
      // Creating actual progress above already materializes the protected day.
      expect(
        await prisma.rirProtectedDay.count({ where: { client_id: owner.id } }),
      ).toBe(1);
      await prisma.rirCycleVersion.create({
        data: {
          client_id: owner.id,
          revision: 1,
          operation_id: randomUUID(),
          request: {},
          effective_from: new Date('2026-09-01'),
          starts_on: new Date('2026-09-01'),
        },
      });
      await prisma.rirDayTarget.create({
        data: {
          client_id: owner.id,
          date: new Date('2026-09-01'),
          training_exercise_id: 'historical-occurrence',
          training_id: training.id,
          target_rir: 2,
        },
      });
    }
    const key = await evidence(a.id);
    const op = await service.request(a.id, adminId);
    expect(op.status).toBe('PENDING');
    expect(removeIdentity).not.toHaveBeenCalled();
    expect(await prisma.user.findUnique({ where: { id: a.id } })).toBeNull();
    expect(await prisma.profile.count({ where: { user_id: a.id } })).toBe(0);
    for (const model of [
      prisma.rirProtectedDay,
      prisma.rirCycleVersion,
      prisma.rirDayTarget,
    ]) {
      expect(await model.count({ where: { client_id: a.id } })).toBe(0);
      expect(await model.count({ where: { client_id: b.id } })).toBe(1);
    }
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
      object_keys: [key],
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
    await prisma.user.update({
      where: { id: adminId },
      data: { identity_pending: true },
    });
    await expect(service.request(a.id, adminId)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(await prisma.user.count({ where: { id: a.id } })).toBe(1);
  });

  it('preserves the client when an earlier identity operation points to a different Firebase account', async () => {
    const a = await client();
    await evidence(a.id);
    const oldUid = `former-${randomUUID()}`;
    const operation = await prisma.identityOperation.create({
      data: {
        request_key: randomUUID(),
        request_hash: 'fixture',
        user_id: a.id,
        actor_id: adminId,
        firebase_uid: oldUid,
        kind: 'CREATE',
        status: 'COMPLETED',
        firebase_owned: true,
      },
    });
    await expect(service.request(a.id, adminId)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(
      await prisma.user.findUnique({ where: { id: a.id } }),
    ).not.toBeNull();
    expect(
      await prisma.clientDeletion.findUnique({ where: { client_id: a.id } }),
    ).toBeNull();
    expect(
      await prisma.identityOperation.findUnique({
        where: { id: operation.id },
      }),
    ).toMatchObject({ firebase_uid: oldUid, status: 'COMPLETED' });
    expect(
      await prisma.managedUpload.count({ where: { owner_id: a.id } }),
    ).toBe(1);
    expect(removeIdentity).not.toHaveBeenCalled();
  });

  it('cancels pending identity recovery and erases its request fingerprint without losing deletion inventory', async () => {
    const a = await client();
    const key = await evidence(a.id);
    const identity = await prisma.identityOperation.create({
      data: {
        request_key: randomUUID(),
        request_hash: 'synthetic-profile-fingerprint',
        user_id: a.id,
        actor_id: adminId,
        firebase_uid: a.firebase_uid,
        kind: 'SYNC',
      },
    });
    await prisma.user.update({
      where: { id: a.id },
      data: { identity_pending: true },
    });
    const op = await service.request(a.id, adminId);
    expect(
      await prisma.identityOperation.findUnique({ where: { id: identity.id } }),
    ).toMatchObject({
      status: 'CANCELLED',
      request_hash: '',
      firebase_uid: a.firebase_uid,
    });
    expect(
      await prisma.clientDeletion.findUnique({ where: { id: op.id } }),
    ).toMatchObject({ object_keys: [key] });
    await service.process(op.id);
    expect(await service.get(op.id)).toMatchObject({ status: 'COMPLETED' });
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
        last_error:
          stage === 'identity'
            ? 'FIREBASE_CLEANUP_PENDING'
            : 'STORAGE_CLEANUP_PENDING',
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

  it('does not let an expired worker overwrite the successor confirmation', async () => {
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
      throw new Error('late failure from old worker');
    });
    const oldWorker = service.process(op.id);
    await started;
    try {
      await prisma.clientDeletion.update({
        where: { id: op.id },
        data: { claimed_at: new Date(0) },
      });
      await service.process(op.id);
      expect(await service.get(op.id)).toMatchObject({
        status: 'COMPLETED',
        attempts: 2,
      });
    } finally {
      release();
      await oldWorker;
    }
    expect(await service.get(op.id)).toMatchObject({
      status: 'COMPLETED',
      last_error: null,
      attempts: 2,
    });
  });

  it('rejects an archive request waiting behind deletion without recreating the client', async () => {
    const a = await client();
    const writer = await pool.connect();
    await writer.query('BEGIN');
    await writer.query(
      'INSERT INTO client_deletions(id,client_id,requested_by,firebase_uid,object_keys) VALUES($1,$2,$3,$4,$5)',
      [randomUUID(), a.id, adminId, a.firebase_uid, []],
    );
    await writer.query('DELETE FROM users WHERE id=$1', [a.id]);
    const usersService = new UsersService(
      prisma as PrismaService,
      undefined!,
      undefined!,
      undefined!,
      undefined!,
    );
    const archive = usersService
      .setClientArchived(adminId, Role.SUPER_ADMIN, a.id, true)
      .then(
        () => 'accepted',
        () => 'rejected',
      );
    let blocked = false;
    try {
      for (let n = 0; n < 100 && !blocked; n++) {
        const locks = await pool.query<{ waiting: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name='f004-deletion-test' AND wait_event_type='Lock') AS waiting",
        );
        blocked = locks.rows[0].waiting;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      await writer.query('COMMIT');
      writer.release();
    }
    expect(await archive).toBe('rejected');
    expect(blocked).toBe(true);
    expect(await prisma.user.count({ where: { id: a.id } })).toBe(0);
    expect(
      await prisma.clientDeletion.count({ where: { client_id: a.id } }),
    ).toBe(1);
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

  it('automatically completes storage cleanup after credential expiry and collects a late recreated object', async () => {
    const a = await client();
    const key = await evidence(a.id);
    jest.spyOn(uploads, 'credentialLifetimeMs').mockReturnValue(900000);
    const op = await service.request(a.id, adminId);
    await service.process(op.id);
    expect(await service.get(op.id)).toMatchObject({
      status: 'PENDING',
      last_error: 'CREDENTIALS_EXPIRING',
      completed_at: null,
    });
    await prisma.clientDeletion.update({
      where: { id: op.id },
      data: { settle_after: new Date(0) },
    });
    jest
      .spyOn(uploads, 'discoverForClientDeletion')
      .mockResolvedValueOnce([key])
      .mockResolvedValue([]);
    await due(op.id);
    await service.recover();
    expect(removeObject.mock.calls).toEqual([[key], [key]]);
    expect((await service.get(op.id)).status).toBe('COMPLETED');
    expect(
      (await prisma.clientDeletion.findUniqueOrThrow({ where: { id: op.id } }))
        .object_keys,
    ).toEqual([key]);
  });

  it('automatically closes without files once earlier Firebase credentials expire', async () => {
    const a = await client();
    const productionIdentity = new DeletionIdentityService();
    jest.spyOn(productionIdentity, 'isAbsent').mockResolvedValue(true);
    const remove = jest
      .spyOn(productionIdentity, 'remove')
      .mockResolvedValue(undefined);
    const worker = new ClientDeletionService(
      prisma as PrismaService,
      uploads,
      productionIdentity,
    );
    const operation = await worker.request(a.id, adminId);
    await worker.process(operation.id);
    expect(await worker.get(operation.id)).toMatchObject({
      status: 'PENDING',
      last_error: 'CREDENTIALS_EXPIRING',
      completed_at: null,
    });
    await prisma.clientDeletion.update({
      where: { id: operation.id },
      data: { settle_after: new Date(0) },
    });
    await due(operation.id);
    await worker.recover();
    expect(remove.mock.calls).toEqual([[a.firebase_uid], [a.firebase_uid]]);
    expect(
      await prisma.clientDeletion.findUnique({ where: { id: operation.id } }),
    ).toMatchObject({ firebase_uid: a.firebase_uid, status: 'COMPLETED' });
  });

  it('automatically reopens a completed receipt for late Firebase and R2 resources without losing inventory', async () => {
    const a = await client();
    const op = await service.request(a.id, adminId);
    await service.process(op.id);
    expect((await service.get(op.id)).status).toBe('COMPLETED');
    const lateKey = `feedback-video/${a.id}/${randomUUID()}.mp4`;
    jest
      .spyOn(uploads, 'discoverForClientDeletion')
      .mockResolvedValueOnce([lateKey])
      .mockResolvedValue([]);
    removeObject.mockImplementationOnce(async (key) => {
      const journal = await prisma.clientDeletion.findUniqueOrThrow({
        where: { id: op.id },
      });
      expect(journal.status).toBe('PROCESSING');
      expect(journal.object_keys).toContain(key);
      throw new Error('simulated storage outage');
    });
    await due(op.id);
    await service.recover();
    expect((await service.get(op.id)).status).toBe('PENDING');
    expect(
      (await prisma.clientDeletion.findUniqueOrThrow({ where: { id: op.id } }))
        .object_keys,
    ).toContain(lateKey);
    await due(op.id);
    await new ClientDeletionService(
      prisma as PrismaService,
      uploads,
      identity,
    ).recover();
    expect((await service.get(op.id)).status).toBe('COMPLETED');
    expect(removeObject).toHaveBeenCalledWith(lateKey);

    removeIdentity.mockClear();
    const previousCompletion = new Date(1000);
    await prisma.clientDeletion.update({
      where: { id: op.id },
      data: { completed_at: previousCompletion },
    });
    jest
      .spyOn(identity, 'isAbsent')
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    await due(op.id);
    await service.recover();
    expect(removeIdentity).toHaveBeenCalledWith(a.firebase_uid);
    expect((await service.get(op.id)).status).toBe('COMPLETED');
    expect((await service.get(op.id)).completed_at!.getTime()).toBeGreaterThan(
      previousCompletion.getTime(),
    );
  });

  it('audits an absent completed receipt without issuing destructive provider calls', async () => {
    const a = await client();
    const op = await service.request(a.id, adminId);
    await service.process(op.id);
    const completed = (await service.get(op.id)).completed_at;
    removeObject.mockClear();
    removeIdentity.mockClear();
    await due(op.id);
    await service.recover();
    expect(removeObject).not.toHaveBeenCalled();
    expect(removeIdentity).not.toHaveBeenCalled();
    expect((await service.get(op.id)).status).toBe('COMPLETED');
    expect((await service.get(op.id)).last_verified_at).not.toBeNull();
    expect((await service.get(op.id)).completed_at).toEqual(completed);
  });

  it('does not certify ambiguous legacy inventory during a completed audit', async () => {
    const a = await client();
    const op = await service.request(a.id, adminId);
    await service.process(op.id);
    await prisma.clientDeletion.update({
      where: { id: op.id },
      data: { object_keys: ['avatar/another-client/shared.jpg'] },
    });
    removeObject.mockClear();
    removeIdentity.mockClear();
    await due(op.id);
    await service.recover();
    expect(await service.get(op.id)).toMatchObject({
      status: 'BLOCKED',
      completed_at: null,
      last_error: 'DELETION_OWNERSHIP_REVIEW',
    });
    expect(removeObject).not.toHaveBeenCalled();
    expect(removeIdentity).not.toHaveBeenCalled();
  });

  it('batches large inventory and resumes the durable cursor after restart', async () => {
    const a = await client();
    const op = await service.request(a.id, adminId);
    const keys = Array.from(
      { length: 205 },
      () => `avatar/${a.id}/${randomUUID()}.jpg`,
    );
    await prisma.clientDeletion.update({
      where: { id: op.id },
      data: { object_keys: keys },
    });
    for (const count of [100, 200, 205]) {
      await due(op.id);
      await new ClientDeletionService(
        prisma as PrismaService,
        uploads,
        identity,
      ).process(op.id);
      expect(removeObject).toHaveBeenCalledTimes(count);
      const current = await prisma.clientDeletion.findUniqueOrThrow({
        where: { id: op.id },
      });
      expect(current.cleanup_cursor).toBe(count);
      expect(current.object_keys).toEqual(keys);
      expect(current.status).toBe(count === 205 ? 'COMPLETED' : 'PENDING');
    }
  });

  it('preserves the receipt on failed final enumeration and completes on automatic retry', async () => {
    const a = await client();
    const key = await evidence(a.id);
    const op = await service.request(a.id, adminId);
    jest
      .spyOn(uploads, 'discoverForClientDeletion')
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('403 fixture'))
      .mockResolvedValue([]);
    await service.process(op.id);
    expect(await service.get(op.id)).toMatchObject({
      status: 'PENDING',
      last_error: 'FINAL_VERIFICATION_PENDING',
    });
    expect(
      (await prisma.clientDeletion.findUniqueOrThrow({ where: { id: op.id } }))
        .object_keys,
    ).toEqual([key]);
    await due(op.id);
    await service.recover();
    expect((await service.get(op.id)).status).toBe('COMPLETED');
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
