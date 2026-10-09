import { Test } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  ClientFollowUpTask,
  ClientFollowUpTaskPriority,
  ClientFollowUpTaskStatus,
  ClientFollowUpTaskType,
  Prisma,
  Role,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ClientFollowUpTasksService,
  CreateClientFollowUpTaskInput,
} from './client-followup-tasks.service';

const actor = { id: 'staff', role: Role.SUPER_ADMIN };
const id = '12345678-1234-4234-8234-123456789abc';
const input: CreateClientFollowUpTaskInput = {
  id,
  type: ClientFollowUpTaskType.CALL,
  title: ' Call ',
  due_date: '2026-10-01',
};
const user = (userId: string, role: Role) => ({
  id: userId,
  role,
  is_active: true,
  is_locked: false,
  is_archived: false,
  identity_pending: false,
});

interface MockUpdateArgs {
  where: Pick<ClientFollowUpTask, 'id' | 'client_id' | 'version'>;
  data: Partial<Omit<ClientFollowUpTask, 'version'>> & {
    version: { increment: number };
  };
}

describe('ClientFollowUpTasksService', () => {
  let service: ClientFollowUpTasksService;
  let rows: ClientFollowUpTask[];
  let users: ReturnType<typeof user>[];
  let assignments: string[];
  let deleting: boolean;
  let locks: Prisma.Sql[];
  const findFirst = jest.fn();
  const createMany = jest.fn();
  const updateMany = jest.fn();
  const transaction = jest.fn();

  beforeEach(async () => {
    rows = [];
    users = [
      user('client', Role.CLIENT),
      user('staff', Role.SUPER_ADMIN),
      user('admin', Role.ADMIN),
    ];
    assignments = ['admin'];
    deleting = false;
    locks = [];
    findFirst.mockImplementation(
      ({ where }: Prisma.ClientFollowUpTaskFindFirstArgs) =>
        rows.find(
          (row) => row.id === where?.id && row.client_id === where?.client_id,
        ) ?? null,
    );
    createMany.mockImplementation(
      ({ data }: { data: Prisma.ClientFollowUpTaskCreateManyInput }) => {
        if (rows.some((row) => row.id === data.id)) return { count: 0 };
        rows.push({
          ...data,
          id: data.id ?? id,
          assigned_to_id: data.assigned_to_id ?? null,
          created_by_id: data.created_by_id ?? null,
          description: data.description ?? null,
          due_date: new Date(data.due_date),
          priority: data.priority ?? ClientFollowUpTaskPriority.MEDIUM,
          status: ClientFollowUpTaskStatus.PENDING,
          version: 1,
          completed_at: null,
          cancelled_at: null,
          created_at: new Date(),
          updated_at: new Date(),
        });
        return { count: 1 };
      },
    );
    updateMany.mockImplementation(({ where, data }: MockUpdateArgs) => {
      const row = rows.find(
        (item) =>
          item.id === where.id &&
          item.client_id === where.client_id &&
          item.version === where.version,
      );
      if (!row) return { count: 0 };
      const { version, ...patch } = data;
      Object.assign(row, patch, { version: row.version + version.increment });
      return { count: 1 };
    });
    const tx = {
      $queryRaw: jest.fn((sql: Prisma.Sql) => {
        locks.push(sql);
        return sql.text.includes('admin_client_assignments')
          ? assignments
              .filter((adminId) => sql.values.includes(adminId))
              .map((adminId) => ({ admin_id: adminId }))
          : [];
      }),
      user: {
        findUnique: jest.fn(
          ({ where }: { where: { id: string } }) =>
            users.find((item) => item.id === where.id) ?? null,
        ),
      },
      clientDeletion: {
        findUnique: jest.fn(() => (deleting ? { id: 'deletion' } : null)),
      },
      clientFollowUpTask: { findFirst, createMany, updateMany },
    };
    // Nest useValue supplies only exercised SDK methods, without a PrismaClient cast.
    transaction.mockImplementation(
      (callback: (value: typeof tx) => Promise<ClientFollowUpTask>) =>
        callback(tx),
    );
    const module = await Test.createTestingModule({
      providers: [
        ClientFollowUpTasksService,
        { provide: PrismaService, useValue: { $transaction: transaction } },
      ],
    }).compile();
    service = module.get(ClientFollowUpTasksService);
  });

  const create = () => service.create('client', input, actor);

  it('creates normalized pending task with internal identifiers and no user DTO', async () => {
    const result = await create();
    expect(result).toMatchObject({
      id,
      client_id: 'client',
      title: 'Call',
      assigned_to_id: 'staff',
      created_by_id: 'staff',
      priority: 'MEDIUM',
      status: 'PENDING',
      version: 1,
    });
    expect(result).not.toHaveProperty('email');
    expect(result).not.toHaveProperty('firebase_uid');
    expect(createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
  });
  it('allows an assigned ADMIN and denies an unassigned ADMIN', async () => {
    await expect(
      service.create('client', input, { id: 'admin', role: Role.ADMIN }),
    ).resolves.toHaveProperty('id', id);
    assignments = [];
    await expect(
      service.get('client', id, { id: 'admin', role: Role.ADMIN }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
  it.each(['client', 'other'])(
    'denies CLIENT on route %s',
    async (clientId) => {
      await expect(
        service.get(clientId, id, { id: 'client', role: Role.CLIENT }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    },
  );
  it.each([
    'is_active',
    'is_locked',
    'is_archived',
    'identity_pending',
    'role',
    'missing',
  ])('revalidates actor %s inside transaction', async (flag) => {
    if (flag === 'missing')
      users = users.filter((item) => item.id !== actor.id);
    else
      users[1] = {
        ...users[1],
        ...(flag === 'role'
          ? { role: Role.ADMIN }
          : { [flag]: flag !== 'is_active' }),
      };
    await expect(create()).rejects.toBeInstanceOf(ForbiddenException);
    expect(rows).toHaveLength(0);
  });
  it('hides tasks belonging to another client', async () => {
    await create();
    users.push(user('other', Role.CLIENT));
    await expect(service.get('other', id, actor)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
  it.each([
    'is_active',
    'is_locked',
    'is_archived',
    'identity_pending',
    'deletion',
  ])('reads history but forbids writes for client %s', async (flag) => {
    await create();
    if (flag === 'deletion') deleting = true;
    else users[0] = { ...users[0], [flag]: flag !== 'is_active' };
    await expect(service.get('client', id, actor)).resolves.toHaveProperty(
      'id',
      id,
    );
    await expect(
      service.update(
        'client',
        id,
        { expected_version: 1, title: 'Edit' },
        actor,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
  it.each(['client', 'missing', 'admin'])(
    'rejects ineligible assignee %s',
    async (assigned_to_id) => {
      assignments = [];
      await expect(
        service.create('client', { ...input, assigned_to_id }, actor),
      ).rejects.toBeInstanceOf(ForbiddenException);
    },
  );
  it('replays once, but conflicts on different payload, creator, owner or version', async () => {
    await create();
    await expect(create()).resolves.toBe(rows[0]);
    expect(rows).toHaveLength(1);
    await expect(
      service.create('client', { ...input, title: 'Different' }, actor),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service.create('client', input, { id: 'admin', role: Role.ADMIN }),
    ).rejects.toBeInstanceOf(ConflictException);
    users.push(user('other', Role.CLIENT));
    await expect(service.create('other', input, actor)).rejects.toBeInstanceOf(
      ConflictException,
    );
    rows[0].version = 2;
    await expect(create()).rejects.toBeInstanceOf(ConflictException);
    expect(rows).toHaveLength(1);
  });
  it.each(['2026-02-30', '0000-01-01', '2026-1-01', '2026-10-01T00:00:00Z'])(
    'rejects malformed day %s',
    async (due_date) => {
      await expect(
        service.create('client', { ...input, due_date }, actor),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );
  it.each(['', '  ', 'a'.repeat(161)])(
    'rejects invalid title',
    async (title) => {
      await expect(
        service.create('client', { ...input, title }, actor),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );
  it('accepts leap day and normalizes multiline description', async () => {
    await expect(
      service.create(
        'client',
        { ...input, due_date: '2028-02-29', description: ' First\r\nSecond ' },
        actor,
      ),
    ).resolves.toMatchObject({
      description: 'First\nSecond',
      due_date: new Date('2028-02-29'),
    });
  });
  it.each([0, -1, 1.5, 2147483648])(
    'rejects invalid expected version %s',
    async (expected_version) => {
      await create();
      await expect(
        service.update('client', id, { expected_version }, actor),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );
  it('does not mutate stale requests, including retry of a committed edit', async () => {
    await create();
    await service.update(
      'client',
      id,
      { expected_version: 1, title: 'Edited' },
      actor,
    );
    await expect(
      service.update(
        'client',
        id,
        { expected_version: 1, title: 'Old' },
        actor,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(rows[0]).toMatchObject({ title: 'Edited', version: 2 });
  });
  it.each([
    ClientFollowUpTaskStatus.COMPLETED,
    ClientFollowUpTaskStatus.CANCELLED,
  ])('stamps %s and makes all closed fields immutable', async (status) => {
    await create();
    await service.update('client', id, { expected_version: 1, status }, actor);
    expect(rows[0].completed_at).toEqual(
      status === 'COMPLETED' ? expect.any(Date) : null,
    );
    expect(rows[0].cancelled_at).toEqual(
      status === 'CANCELLED' ? expect.any(Date) : null,
    );
    await expect(
      service.update(
        'client',
        id,
        { expected_version: 2, title: 'Closed edit' },
        actor,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service.update(
        'client',
        id,
        { expected_version: 1, status: ClientFollowUpTaskStatus.COMPLETED },
        actor,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });
  it('keeps null legacy assignee on unrelated edit and null timestamps while open', async () => {
    await create();
    rows[0].assigned_to_id = null;
    await service.update(
      'client',
      id,
      { expected_version: 1, status: ClientFollowUpTaskStatus.IN_PROGRESS },
      actor,
    );
    expect(rows[0]).toMatchObject({
      assigned_to_id: null,
      completed_at: null,
      cancelled_at: null,
      version: 2,
    });
  });
  it('conflicts rather than overflowing PostgreSQL Int', async () => {
    await create();
    rows[0].version = 2147483647;
    await expect(
      service.update('client', id, { expected_version: 2147483647 }, actor),
    ).rejects.toBeInstanceOf(ConflictException);
  });
  it('locks advisory, sorted User SHARE, assignment UPDATE, then owned task UPDATE', async () => {
    await service.create('client', input, { id: 'admin', role: Role.ADMIN });
    locks = [];
    await service.update(
      'client',
      id,
      { expected_version: 1, assigned_to_id: 'admin' },
      { id: 'admin', role: Role.ADMIN },
    );
    expect(locks.map((sql) => sql.text)).toEqual([
      expect.stringContaining('pg_advisory_xact_lock_shared'),
      expect.stringContaining('pg_advisory_xact_lock('),
      expect.stringMatching(/users[\s\S]*ORDER BY id FOR SHARE/),
      expect.stringMatching(
        /admin_client_assignments[\s\S]*ORDER BY admin_id FOR UPDATE/,
      ),
      expect.stringMatching(/client_followup_tasks[\s\S]*FOR UPDATE/),
    ]);
    expect(locks[2].values).toEqual(['admin', 'client']);
    expect(locks[3].values).toEqual(['client', 'admin']);
    expect(locks[4].values).toEqual([id, 'client']);
    expect(transaction).toHaveBeenLastCalledWith(
      expect.any(Function),
      expect.objectContaining({
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      }),
    );
    expect(updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { id, client_id: 'client', version: 1 },
      }),
    );
  });
  it('orders and deduplicates two ADMIN locks before the task', async () => {
    await create();
    users.push(user('aaa', Role.ADMIN));
    assignments.push('aaa');
    locks = [];
    await service.update(
      'client',
      id,
      { expected_version: 1, assigned_to_id: 'aaa' },
      { id: 'admin', role: Role.ADMIN },
    );
    expect(locks[2].values).toEqual(['aaa', 'admin', 'client']);
    expect(locks[3].values).toEqual(['client', 'aaa', 'admin']);
  });
  it('preserves stale historical assignees on unrelated edits', async () => {
    await create();
    rows[0].assigned_to_id = 'old-staff';
    await service.update('client', id, { expected_version: 1 }, actor);
    expect(rows[0].assigned_to_id).toBe('old-staff');
  });
  it('rejects inactive explicit assignee and accepts active assigned ADMIN', async () => {
    await service.create(
      'client',
      { ...input, assigned_to_id: 'admin' },
      actor,
    );
    users[2].is_active = false;
    await expect(
      service.update(
        'client',
        id,
        { expected_version: 1, assigned_to_id: 'admin' },
        actor,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('handles conditional update losing its match without mutating row', async () => {
    await create();
    updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      service.update('client', id, { expected_version: 1 }, actor),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(rows[0].version).toBe(1);
  });
  it('rejects invalid operation UUID and excessive description', async () => {
    await expect(
      service.create('client', { ...input, id: 'not-a-uuid' }, actor),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.create(
        'client',
        { ...input, description: 'a'.repeat(3001) },
        actor,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
  it('accepts year 0001 and nullable description', async () => {
    await expect(
      service.create(
        'client',
        { ...input, due_date: '0001-01-01', description: null },
        actor,
      ),
    ).resolves.toMatchObject({
      due_date: new Date('0001-01-01'),
      description: null,
    });
  });
});
