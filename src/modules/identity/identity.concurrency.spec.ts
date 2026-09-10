import {
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaClient, Prisma, Role } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import type * as admin from 'firebase-admin';
import { IdentityProvider } from './identity-provider';
import { IdentityService } from './identity.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { ConfigService } from '@nestjs/config';

const customToken = jest.fn<Promise<string>, [string]>();
jest.mock('firebase-admin', () => ({
  auth: () => ({ createCustomToken: customToken }),
}));

function record(
  uid: string,
  email: string,
  disabled = false,
): admin.auth.UserRecord {
  return {
    uid,
    email,
    disabled,
    emailVerified: false,
    providerData: [],
    metadata: {
      creationTime: new Date().toUTCString(),
      lastSignInTime: '',
      toJSON: () => ({}),
    },
    toJSON: () => ({}),
  };
}

class FakeIdentity extends IdentityProvider {
  users = new Map<string, admin.auth.UserRecord>();
  get = jest.fn((uid: string) => Promise.resolve(this.users.get(uid) ?? null));
  create = jest.fn((input: admin.auth.CreateRequest) => {
    if (!input.uid || !input.email)
      throw Error('Fixture requires explicit UID/email');
    if ([...this.users.values()].some((user) => user.email === input.email))
      throw Object.assign(new Error('Email exists'), {
        code: 'auth/email-already-exists',
      });
    const user = record(input.uid, input.email);
    this.users.set(input.uid, user);
    return Promise.resolve(user);
  });
  update = jest.fn((uid: string, input: admin.auth.UpdateRequest) => {
    const user = this.users.get(uid);
    if (!user)
      throw Object.assign(new Error('Missing user'), {
        code: 'auth/user-not-found',
      });
    const updated = {
      ...user,
      email: input.email ?? user.email,
      disabled: input.disabled ?? user.disabled,
    };
    this.users.set(uid, updated);
    return Promise.resolve(updated);
  });
  revoke = jest.fn(() => Promise.resolve());
  remove = jest.fn(async (uid: string) => {
    this.users.delete(uid);
    await Promise.resolve();
  });
}

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)(
  'P5 identity recovery (real PostgreSQL / simulated Firebase)',
  () => {
    let pool: Pool;
    let prisma: PrismaClient;
    let firebase: FakeIdentity;
    let service: IdentityService;
    let actorId: string;
    const ids: string[] = [];
    const actors: string[] = [];

    beforeAll(async () => {
      const target = new URL(url!);
      if (
        target.hostname !== '127.0.0.1' ||
        target.port !== '55437' ||
        target.pathname !== '/exom_review'
      )
        throw Error('Isolated DB required');
      pool = new Pool({
        connectionString: url,
        application_name: 'p5-identity-test',
      });
      const result = await pool.query<{ data_directory: string }>(
        'SHOW data_directory',
      );
      if (
        !result.rows[0].data_directory
          .replaceAll('\\', '/')
          .endsWith('/EXOM/phase4-20260906/pgdata')
      )
        throw Error('Unexpected cluster');
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    });
    beforeEach(async () => {
      customToken.mockReset();
      firebase = new FakeIdentity();
      // Real Prisma transaction implementation; Nest lifecycle methods are unused.
      service = new IdentityService(prisma as PrismaService, firebase);
      actorId = (await client(Role.SUPER_ADMIN)).id;
      actors.push(actorId);
    });
    afterEach(async () => {
      const created = await prisma.identityOperation.findMany({
        where: { actor_id: { in: actors } },
        select: { user_id: true },
      });
      await prisma.user.deleteMany({
        where: { id: { in: [...ids, ...created.map((op) => op.user_id)] } },
      });
      await prisma.identityOperation.deleteMany({
        where: { OR: [{ actor_id: { in: actors } }, { user_id: { in: ids } }] },
      });
      ids.length = 0;
      actors.length = 0;
      jest.restoreAllMocks();
    });
    afterAll(async () => {
      await prisma?.$disconnect();
      await pool?.end();
    });

    async function client(role: Role = Role.CLIENT) {
      const id = randomUUID();
      ids.push(id);
      const user = await prisma.user.create({
        data: {
          id,
          email: `${id}@example.test`,
          firebase_uid: `fixture-${id}`,
          role,
        },
        include: { profile: true },
      });
      firebase?.users.set(
        user.firebase_uid,
        record(user.firebase_uid, user.email),
      );
      return user;
    }
    function creation(key = randomUUID(), role: Role = Role.CLIENT) {
      const email = `${randomUUID()}@example.test`;
      const input = {
        actorId,
        role,
        email,
        password: 'fixture-password',
        firstName: 'Fixture',
        lastName: 'Client',
        fingerprint: ['Fixture', 'Client'],
        key,
      };
      const persist = (tx: Prisma.TransactionClient, uid: string, id: string) =>
        tx.user.create({
          data: { id, email, firebase_uid: uid, role },
          include: { profile: true },
        });
      return { input, persist };
    }
    async function status(id: string, active: boolean, key = randomUUID()) {
      return service.change(
        actorId,
        id,
        'SYNC',
        active,
        async (tx) => {
          await tx.user.update({ where: { id }, data: { is_active: active } });
        },
        key,
      );
    }

    it.each([Role.ADMIN, Role.CLIENT])(
      'compensates a %s Firebase account created by this request if PostgreSQL fails',
      async (role) => {
        const { input } = creation(randomUUID(), role);
        await expect(
          service.create(input, () => Promise.reject(Error('DB_WRITE_FAILED'))),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(firebase.users.size).toBe(1); // only the administrative fixture remains
        expect(firebase.remove).toHaveBeenCalledTimes(1);
        expect(
          await prisma.identityOperation.findFirst({
            where: { actor_id: actorId },
          }),
        ).toMatchObject({ status: 'COMPENSATED', firebase_owned: true });
      },
    );

    it('retains failed compensation durably and recovers without the original request', async () => {
      const { input } = creation();
      firebase.remove.mockRejectedValueOnce(Error('EXTERNAL_FAILURE'));
      await expect(
        service.create(input, () => Promise.reject(Error('DB_WRITE_FAILED'))),
      ).rejects.toThrow();
      const operation = await prisma.identityOperation.findFirstOrThrow({
        where: { actor_id: actorId },
      });
      expect(operation).toMatchObject({
        status: 'PENDING',
        last_error: 'CREATE_COMPENSATION_PENDING',
      });
      await new IdentityService(
        prisma as PrismaService,
        firebase,
      ).recoverOperation(operation.id);
      expect(
        await prisma.identityOperation.findUnique({
          where: { id: operation.id },
        }),
      ).toMatchObject({ status: 'COMPENSATED' });
      expect(firebase.users.has(operation.firebase_uid)).toBe(false);
    });

    it('never adopts or deletes a preexisting Firebase account with the same email', async () => {
      const { input, persist } = creation();
      firebase.users.set('existing', record('existing', input.email));
      await expect(service.create(input, persist)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(firebase.users.has('existing')).toBe(true);
      expect(firebase.remove).not.toHaveBeenCalled();
    });

    it('retains ambiguous lost create acknowledgements without deleting an unproven account', async () => {
      const { input, persist } = creation();
      firebase.create.mockImplementationOnce(async (request) => {
        const user = record(request.uid!, request.email!);
        firebase.users.set(user.uid, user);
        await Promise.resolve();
        throw Error('RESPONSE_LOST');
      });
      await expect(service.create(input, persist)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      const op = await prisma.identityOperation.findFirstOrThrow({
        where: { actor_id: actorId },
      });
      expect(op.status).toBe('BLOCKED');
      await service.recoverOperation(op.id);
      expect(firebase.remove).not.toHaveBeenCalled();
      expect(firebase.users.has(op.firebase_uid)).toBe(true);
    });

    it('returns the same created account after response loss and concurrent duplicate requests', async () => {
      const { input, persist } = creation();
      const results = await Promise.allSettled([
        service.create(input, persist),
        service.create(input, persist),
      ]);
      expect(results.some((result) => result.status === 'fulfilled')).toBe(
        true,
      );
      const replay = await service.create(input, persist);
      expect(firebase.create).toHaveBeenCalledTimes(1);
      expect(await prisma.user.count({ where: { email: input.email } })).toBe(
        1,
      );
      expect(replay.email).toBe(input.email);
      await expect(
        service.create({ ...input, fingerprint: ['different'] }, persist),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('checks current administrative authorization before creating external state', async () => {
      const { input, persist } = creation();
      await prisma.user.update({
        where: { id: actorId },
        data: { is_active: false },
      });
      await expect(service.create(input, persist)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(firebase.create).not.toHaveBeenCalled();
    });

    it('rolls back both the desired state and journal if the DB write fails, with no Firebase effect', async () => {
      const user = await client();
      await expect(
        service.change(actorId, user.id, 'SYNC', false, async (tx) => {
          await tx.user.update({
            where: { id: user.id },
            data: { is_active: false },
          });
          throw Error('DB_WRITE_FAILED');
        }),
      ).rejects.toThrow('DB_WRITE_FAILED');
      expect(
        await prisma.user.findUnique({ where: { id: user.id } }),
      ).toMatchObject({ is_active: true, identity_pending: false });
      expect(
        await prisma.identityOperation.count({ where: { user_id: user.id } }),
      ).toBe(0);
      expect(firebase.update).not.toHaveBeenCalled();
    });

    it.each(['get', 'update', 'revoke'] as const)(
      'persists and recovers a %s failure when disabling a user',
      async (step) => {
        const user = await client();
        firebase[step].mockRejectedValueOnce({
          code: 'auth/insufficient-permission',
        });
        const key = randomUUID();
        await expect(status(user.id, false, key)).rejects.toBeInstanceOf(
          ServiceUnavailableException,
        );
        expect(
          await prisma.user.findUnique({ where: { id: user.id } }),
        ).toMatchObject({ is_active: false, identity_pending: true });
        await expect(status(user.id, true)).rejects.toBeInstanceOf(
          ConflictException,
        );
        const op = await prisma.identityOperation.findFirstOrThrow({
          where: { user_id: user.id },
        });
        await service.recoverOperation(op.id);
        expect(
          await prisma.user.findUnique({ where: { id: user.id } }),
        ).toMatchObject({ is_active: false, identity_pending: false });
        expect(firebase.users.get(user.firebase_uid)?.disabled).toBe(true);
        await status(user.id, true);
        await status(user.id, false, key); // old operation is a receipt, not a new disable
        expect(
          await prisma.user.findUnique({ where: { id: user.id } }),
        ).toMatchObject({ is_active: true });
      },
    );

    it('reconciles email after a lost remote response without reverting to stale data', async () => {
      const user = await client();
      const email = `${randomUUID()}@example.test`;
      firebase.update.mockImplementationOnce(async (uid, input) => {
        firebase.users.set(uid, record(uid, input.email!));
        await Promise.resolve();
        throw Error('RESPONSE_LOST');
      });
      await expect(
        service.change(actorId, user.id, 'SYNC', email, async (tx) => {
          await tx.user.update({ where: { id: user.id }, data: { email } });
        }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      const op = await prisma.identityOperation.findFirstOrThrow({
        where: { user_id: user.id },
      });
      expect(JSON.stringify(op)).not.toContain(email);
      await service.recoverOperation(op.id);
      expect(
        await prisma.user.findUnique({ where: { id: user.id } }),
      ).toMatchObject({ email, identity_pending: true });
      expect(
        await prisma.identityOperation.findUnique({ where: { id: op.id } }),
      ).toMatchObject({
        status: 'BLOCKED',
        last_error: 'FIREBASE_OUTCOME_REVIEW',
      });
    });

    it('keeps uncertainty when two workers read the same initial snapshot and one loses its response', async () => {
      const user = await client();
      firebase.get.mockRejectedValueOnce({
        code: 'auth/insufficient-permission',
      });
      await expect(status(user.id, false)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      const operation = await prisma.identityOperation.findFirstOrThrow({
        where: { user_id: user.id },
      });
      let release!: () => void;
      const bothRead = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reads = 0;
      const concurrentPrisma = prisma.$extends({
        query: {
          identityOperation: {
            async findUnique({ args, query }) {
              const result = await query(args);
              if (args.where.id === operation.id && ++reads <= 2) {
                if (reads === 2) release();
                await bothRead;
              }
              return result;
            },
          },
        },
      });
      // Extension preserves the real transaction implementation and adds only
      // a deterministic read barrier; Nest lifecycle methods remain unused.
      const worker = new IdentityService(
        concurrentPrisma as unknown as PrismaService,
        firebase,
      );
      firebase.update.mockRejectedValueOnce(Error('RESPONSE_LOST'));
      await Promise.all([
        worker.recoverOperation(operation.id),
        worker.recoverOperation(operation.id),
      ]);
      expect(
        await prisma.identityOperation.findUnique({
          where: { id: operation.id },
        }),
      ).toMatchObject({
        status: 'BLOCKED',
        last_error: 'FIREBASE_OUTCOME_REVIEW',
      });
      expect(
        await prisma.user.findUnique({ where: { id: user.id } }),
      ).toMatchObject({ identity_pending: true });
    });

    it('fences a worker paused after its marker when a successor loses a response', async () => {
      const user = await client();
      firebase.get.mockRejectedValueOnce({
        code: 'auth/insufficient-permission',
      });
      await expect(status(user.id, false)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      const operation = await prisma.identityOperation.findFirstOrThrow({
        where: { user_id: user.id },
      });
      let marked!: () => void;
      let release!: () => void;
      const markerWritten = new Promise<void>((resolve) => {
        marked = resolve;
      });
      const resume = new Promise<void>((resolve) => {
        release = resolve;
      });
      let paused = false;
      const delayedPrisma = prisma.$extends({
        query: {
          async $queryRaw({ args, query }) {
            const result: unknown = await query(args);
            if (!paused) {
              paused = true;
              marked();
              await resume;
            }
            return result;
          },
        },
      });
      // Real Prisma and locks; pause only the response to the committed marker.
      const delayed = new IdentityService(
        delayedPrisma as unknown as PrismaService,
        firebase,
      );
      const oldWorker = delayed.recoverOperation(operation.id);
      await markerWritten;
      try {
        firebase.update.mockRejectedValueOnce(Error('RESPONSE_LOST'));
        await service.recoverOperation(operation.id);
      } finally {
        release();
      }
      await oldWorker;
      expect(
        await prisma.identityOperation.findUnique({
          where: { id: operation.id },
        }),
      ).toMatchObject({
        status: 'BLOCKED',
        last_error: 'FIREBASE_OUTCOME_REVIEW',
      });
      expect(firebase.update).toHaveBeenCalledTimes(1);
      expect(
        await prisma.user.findUnique({ where: { id: user.id } }),
      ).toMatchObject({ identity_pending: true });
    });

    it('does not let a delayed failure handler erase the successor uncertainty', async () => {
      const user = await client();
      firebase.get.mockRejectedValueOnce({
        code: 'auth/insufficient-permission',
      });
      await expect(status(user.id, false)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      const operation = await prisma.identityOperation.findFirstOrThrow({
        where: { user_id: user.id },
      });
      let failing!: () => void;
      let release!: () => void;
      const beforeFailureSave = new Promise<void>((resolve) => {
        failing = resolve;
      });
      const resume = new Promise<void>((resolve) => {
        release = resolve;
      });
      const delayedPrisma = prisma.$extends({
        query: {
          identityOperation: {
            async updateMany({ args, query }) {
              failing();
              await resume;
              return query(args);
            },
          },
        },
      });
      const delayed = new IdentityService(
        delayedPrisma as unknown as PrismaService,
        firebase,
      );
      firebase.update.mockRejectedValueOnce({
        code: 'auth/insufficient-permission',
      });
      const oldWorker = delayed.recoverOperation(operation.id);
      await beforeFailureSave;
      try {
        await service.recoverOperation(operation.id);
      } finally {
        release();
      }
      await oldWorker;
      expect(
        await prisma.identityOperation.findUnique({
          where: { id: operation.id },
        }),
      ).toMatchObject({
        status: 'BLOCKED',
        last_error: 'FIREBASE_OUTCOME_REVIEW',
      });
    });

    it('keeps missing Firebase accounts blocked and never recreates them', async () => {
      const user = await client();
      firebase.users.delete(user.firebase_uid);
      await expect(status(user.id, false)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(
        await prisma.identityOperation.findFirst({
          where: { user_id: user.id },
        }),
      ).toMatchObject({ status: 'BLOCKED' });
      expect(firebase.create).not.toHaveBeenCalled();
    });

    it('records a local revocation cutoff even when Firebase is unavailable, then retries', async () => {
      const user = await client();
      firebase.revoke.mockRejectedValueOnce({
        code: 'auth/insufficient-permission',
      });
      const key = randomUUID();
      await expect(service.revoke(user.id, key)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      const pending = await prisma.user.findUniqueOrThrow({
        where: { id: user.id },
      });
      expect(pending.sessions_revoked_at).not.toBeNull();
      await service.revoke(user.id, key);
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: user.id } }))
          .sessions_revoked_at,
      ).toEqual(pending.sessions_revoked_at);
    });

    it('holds the user barrier while minting a custom token and a deletion waits', async () => {
      const user = await client();
      const auth = new AuthService(
        prisma as PrismaService,
        new ConfigService({ FIREBASE_WEB_API_KEY: 'isolated-fixture' }),
      );
      jest.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ localId: user.firebase_uid }), {
          status: 200,
        }),
      );
      let release!: () => void;
      let entered!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      customToken.mockImplementation(async () => {
        entered();
        await barrier;
        return 'fixture-custom-token';
      });
      const login = auth.login({ email: user.email, password: 'fixture' });
      await started;
      expect(customToken).toHaveBeenCalledWith(user.firebase_uid, {
        exom_session_epoch: '0',
      });
      const connection = await pool.connect();
      const pid = (
        await connection.query<{ pid: number }>(
          'SELECT pg_backend_pid() AS pid',
        )
      ).rows[0].pid;
      const deletion = connection.query('DELETE FROM users WHERE id=$1', [
        user.id,
      ]);
      try {
        let blocked = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          const result = await pool.query<{ waiting: boolean }>(
            "SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1",
            [pid],
          );
          if (result.rows[0]?.waiting) {
            blocked = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(blocked).toBe(true);
      } finally {
        release();
      }
      await Promise.all([login, deletion]);
      connection.release();
      expect(
        await prisma.user.findUnique({ where: { id: user.id } }),
      ).toBeNull();
      expect(customToken).toHaveBeenCalledTimes(1);
    });

    it('advances the revocation epoch despite a backwards worker clock', async () => {
      const user = await client();
      const previous = new Date(Date.now() + 60000);
      await prisma.user.update({
        where: { id: user.id },
        data: { sessions_revoked_at: previous },
      });
      await service.revoke(user.id, randomUUID());
      const updated = await prisma.user.findUniqueOrThrow({
        where: { id: user.id },
      });
      expect(updated.sessions_revoked_at!.getTime()).toBeGreaterThan(
        previous.getTime(),
      );
    });

    it('serializes a real in-flight Firebase write with a concurrent database deletion', async () => {
      const user = await client();
      let release!: () => void;
      let entered!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const update = firebase.update.getMockImplementation()!;
      firebase.update.mockImplementationOnce(async (uid, data) => {
        entered();
        await barrier;
        return update(uid, data);
      });
      const change = status(user.id, false);
      await started;
      const deleting = pool.connect();
      const connection = await deleting;
      const pid = (
        await connection.query<{ pid: number }>(
          'SELECT pg_backend_pid() AS pid',
        )
      ).rows[0].pid;
      const deletion = connection.query('DELETE FROM users WHERE id=$1', [
        user.id,
      ]);
      try {
        let blocked = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          const result = await pool.query<{ waiting: boolean }>(
            "SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1",
            [pid],
          );
          if (result.rows[0]?.waiting) {
            blocked = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(blocked).toBe(true);
      } finally {
        release();
      }
      await Promise.allSettled([change, deletion]);
      connection.release();
      expect(
        await prisma.user.findUnique({ where: { id: user.id } }),
      ).toBeNull();
      expect(
        await prisma.identityOperation.findFirst({
          where: { user_id: user.id },
        }),
      ).toMatchObject({ status: 'COMPLETED' });
    });
  },
);
