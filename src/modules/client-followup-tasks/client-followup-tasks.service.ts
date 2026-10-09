import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ClientFollowUpTask,
  ClientFollowUpTaskPriority,
  ClientFollowUpTaskStatus,
  ClientFollowUpTaskType,
  Prisma,
  Role,
  User,
} from '@prisma/client';
import { formatDateOnly } from '../../common/date-only';
import {
  DAY_PROGRESS_TRANSACTION_OPTIONS,
  lockClientDayProgress,
} from '../../common/progress/day-progress-lock';
import { PrismaService } from '../../prisma/prisma.service';
import {
  nextTasksQuery,
  assigneesQuery,
  taskListQuery,
  eligibleStaffFlags,
  staffRoles,
  requiresClientAssignment,
  type AssigneeDisplay,
  type ListedTask,
  type PageSnapshot,
  type NextTaskRow,
  type SelectedNextTask,
} from './client-followup-tasks.queries';

import type {
  ClientFollowUpTaskListDto,
  FollowUpPageDto,
} from './dto/client-followup-task-list.dto';

export interface NextTaskProjection extends Omit<NextTaskRow, 'due_date'> {
  due_date: string;
  overdue: boolean;
}

export interface ClientFollowUpTaskSummary {
  as_of_date: string;
  next_task: NextTaskProjection | null;
  next_review: NextTaskProjection | null;
}

export interface ClientFollowUpTaskActor {
  id: string;
  role: string;
}

export interface ClientFollowUpTaskFields {
  type?: ClientFollowUpTaskType;
  title?: string;
  description?: string | null;
  due_date?: string;
  priority?: ClientFollowUpTaskPriority;
  assigned_to_id?: string;
}

export interface CreateClientFollowUpTaskInput extends ClientFollowUpTaskFields {
  id: string;
  type: ClientFollowUpTaskType;
  title: string;
  due_date: string;
}

export interface UpdateClientFollowUpTaskInput extends ClientFollowUpTaskFields {
  expected_version: number;
  status?: ClientFollowUpTaskStatus;
}

interface NormalizedTaskFields extends Omit<
  ClientFollowUpTaskFields,
  'due_date'
> {
  due_date?: Date;
}

const MAX_VERSION = 2147483647;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const userSelection = {
  id: true,
  role: true,
  is_active: true,
  is_locked: true,
  is_archived: true,
  identity_pending: true,
} as const;
type ScopeUser = Prisma.UserGetPayload<{ select: typeof userSelection }>;

@Injectable()
export class ClientFollowUpTasksService {
  constructor(private readonly prisma: PrismaService) {}

  private eligible(
    user: Pick<
      User,
      'is_active' | 'is_locked' | 'is_archived' | 'identity_pending'
    >,
  ): boolean {
    return (
      user.is_active === eligibleStaffFlags.is_active &&
      user.is_locked === eligibleStaffFlags.is_locked &&
      user.is_archived === eligibleStaffFlags.is_archived &&
      user.identity_pending === eligibleStaffFlags.identity_pending
    );
  }

  // All entry points use the same lock order, including reads and replay.
  // SHARE (not KEY SHARE) blocks non-key role/deactivation changes through commit.
  // User locks precede assignments to avoid staff deletion's User -> assignment cycle.
  private async scope(
    tx: Prisma.TransactionClient,
    clientId: string,
    actor: ClientFollowUpTaskActor,
    write: boolean,
    assigneeId?: string,
  ): Promise<void> {
    if (actor.role !== Role.ADMIN && actor.role !== Role.SUPER_ADMIN)
      throw new ForbiddenException('Staff access required');
    await lockClientDayProgress(tx, clientId);
    const ids = [
      ...new Set([clientId, actor.id, ...(assigneeId ? [assigneeId] : [])]),
    ].sort();
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM users WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR SHARE`,
    );
    const current = await tx.user.findUnique({
      where: { id: actor.id },
      select: userSelection,
    });
    if (!current || !this.eligible(current) || current.role !== actor.role)
      throw new ForbiddenException('Staff access changed');
    const client = await tx.user.findUnique({
      where: { id: clientId },
      select: userSelection,
    });
    if (client?.role !== Role.CLIENT)
      throw new NotFoundException('Client not found');
    if (
      write &&
      (!this.eligible(client) ||
        (await tx.clientDeletion.findUnique({
          where: { client_id: clientId },
          select: { id: true },
        })))
    )
      throw new ForbiddenException('Client is not writable');
    let assignee: ScopeUser | null = null;
    if (assigneeId !== undefined) {
      assignee = await tx.user.findUnique({
        where: { id: assigneeId },
        select: userSelection,
      });
      if (
        !assignee ||
        !this.eligible(assignee) ||
        !staffRoles.includes(assignee.role)
      )
        throw new ForbiddenException('Assignee must be active staff');
    }
    const adminIds = [
      ...new Set([
        ...(current.role === Role.ADMIN ? [current.id] : []),
        ...(assignee && requiresClientAssignment(assignee.role)
          ? [assignee.id]
          : []),
      ]),
    ].sort();
    if (adminIds.length) {
      const assignments = await tx.$queryRaw<{ admin_id: string }[]>(Prisma.sql`
        SELECT admin_id FROM admin_client_assignments
        WHERE client_id = ${clientId} AND admin_id IN (${Prisma.join(adminIds)}) AND is_active = true
        ORDER BY admin_id FOR UPDATE`);
      if (
        adminIds.some(
          (adminId) => !assignments.some((row) => row.admin_id === adminId),
        )
      )
        throw new ForbiddenException('Client not assigned to staff');
    }
  }

  private transaction<T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(work, {
      ...DAY_PROGRESS_TRANSACTION_OPTIONS,
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    });
  }

  private async owned(
    tx: Prisma.TransactionClient,
    clientId: string,
    taskId: string,
  ): Promise<ClientFollowUpTask> {
    const task = await tx.clientFollowUpTask.findFirst({
      where: { id: taskId, client_id: clientId },
    });
    if (!task) throw new NotFoundException('Task not found');
    return task;
  }

  get(
    clientId: string,
    taskId: string,
    actor: ClientFollowUpTaskActor,
  ): Promise<ClientFollowUpTask> {
    return this.transaction(async (tx) => {
      await this.scope(tx, clientId, actor, false);
      return this.owned(tx, clientId, taskId);
    });
  }

  // Canonical shared source for future staff consumers; never materializes tasks.
  summary(
    clientId: string,
    actor: ClientFollowUpTaskActor,
  ): Promise<ClientFollowUpTaskSummary> {
    const asOfDate = formatDateOnly(new Date());
    return this.transaction(async (tx) => {
      await this.scope(tx, clientId, actor, false);
      const rows = await tx.$queryRaw<SelectedNextTask[]>(
        nextTasksQuery(clientId),
      );
      const project = (selector: string): NextTaskProjection | null => {
        const row = rows.find((entry) => entry.selector === selector);
        if (!row) return null;
        const dueDate = formatDateOnly(row.due_date);
        return {
          id: row.id,
          type: row.type,
          title: row.title,
          due_date: dueDate,
          priority: row.priority,
          assigned_to_id: row.assigned_to_id,
          version: row.version,
          overdue: dueDate < asOfDate,
        };
      };
      return {
        as_of_date: asOfDate,
        next_task: project('task'),
        next_review: project('review'),
      };
    });
  }

  private readPage<T>(
    clientId: string,
    actor: ClientFollowUpTaskActor,
    page: FollowUpPageDto,
    query: Prisma.Sql,
  ) {
    return this.transaction(async (tx) => {
      await this.scope(tx, clientId, actor, false);
      const [snapshot] = await tx.$queryRaw<PageSnapshot<T>[]>(query);
      const total = Number(snapshot.total);
      return {
        data: snapshot.data,
        total,
        page: page.page,
        limit: page.limit,
        totalPages: Math.ceil(total / page.limit),
      };
    });
  }

  list(
    clientId: string,
    actor: ClientFollowUpTaskActor,
    query: ClientFollowUpTaskListDto,
  ) {
    return this.readPage<ListedTask>(
      clientId,
      actor,
      query,
      taskListQuery(clientId, query),
    );
  }

  assignees(
    clientId: string,
    actor: ClientFollowUpTaskActor,
    query: FollowUpPageDto,
  ) {
    return this.readPage<AssigneeDisplay>(
      clientId,
      actor,
      query,
      assigneesQuery(clientId, query),
    );
  }

  private fields(input: ClientFollowUpTaskFields): NormalizedTaskFields {
    const data: NormalizedTaskFields = {};
    if (input.title !== undefined) {
      if (
        typeof input.title !== 'string' ||
        !input.title.trim() ||
        input.title.trim().length > 160
      )
        throw new BadRequestException('Title must contain 1 to 160 characters');
      data.title = input.title.trim();
    }
    if (input.description !== undefined) {
      if (input.description !== null && typeof input.description !== 'string')
        throw new BadRequestException('Description must be text or null');
      const text =
        input.description === null
          ? null
          : input.description.replace(/\r\n?/g, '\n').trim();
      if (text !== null && text.length > 3000)
        throw new BadRequestException('Description exceeds 3000 characters');
      data.description = text;
    }
    if (input.due_date !== undefined) {
      // setUTCFullYear supports years 0001-0099 without Date.UTC's 1900 offset.
      if (
        typeof input.due_date !== 'string' ||
        !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(input.due_date) ||
        input.due_date.startsWith('0000')
      )
        throw new BadRequestException(
          'Due date must be a valid YYYY-MM-DD date',
        );
      const [year, month, day] = input.due_date.split('-').map(Number);
      const date = new Date(0);
      date.setUTCFullYear(year, month - 1, day);
      if (formatDateOnly(date) !== input.due_date)
        throw new BadRequestException(
          'Due date must be a valid YYYY-MM-DD date',
        );
      data.due_date = date;
    }
    if (input.type !== undefined) {
      if (!Object.values(ClientFollowUpTaskType).includes(input.type))
        throw new BadRequestException('Invalid task type');
      data.type = input.type;
    }
    if (input.priority !== undefined) {
      if (!Object.values(ClientFollowUpTaskPriority).includes(input.priority))
        throw new BadRequestException('Invalid task priority');
      data.priority = input.priority;
    }
    if (input.assigned_to_id !== undefined) {
      if (
        typeof input.assigned_to_id !== 'string' ||
        !input.assigned_to_id.trim()
      )
        throw new BadRequestException('Assignee is required');
      data.assigned_to_id = input.assigned_to_id;
    }
    return data;
  }

  async create(
    clientId: string,
    input: CreateClientFollowUpTaskInput,
    actor: ClientFollowUpTaskActor,
  ): Promise<ClientFollowUpTask> {
    if (typeof input.id !== 'string' || !UUID.test(input.id))
      throw new BadRequestException('Task id must be a UUID');
    const fields = this.fields(input);
    if (
      fields.type === undefined ||
      fields.title === undefined ||
      fields.due_date === undefined
    )
      throw new BadRequestException('Type, title and due date are required');
    // Never accept owner, creator, status or version from input.
    const data: Prisma.ClientFollowUpTaskCreateManyInput = {
      id: input.id.toLowerCase(),
      client_id: clientId,
      created_by_id: actor.id,
      assigned_to_id: input.assigned_to_id ?? actor.id,
      type: fields.type,
      title: fields.title,
      description: fields.description ?? null,
      due_date: fields.due_date,
      priority: input.priority ?? ClientFollowUpTaskPriority.MEDIUM,
      status: ClientFollowUpTaskStatus.PENDING,
      version: 1,
    };
    return this.transaction(async (tx) => {
      await this.scope(
        tx,
        clientId,
        actor,
        true,
        data.assigned_to_id ?? undefined,
      );
      await tx.clientFollowUpTask.createMany({ data, skipDuplicates: true });
      const task = await tx.clientFollowUpTask.findFirst({
        where: { id: data.id, client_id: clientId },
      });
      if (
        !task ||
        task.version !== 1 ||
        task.created_by_id !== actor.id ||
        task.assigned_to_id !== data.assigned_to_id ||
        task.type !== data.type ||
        task.title !== data.title ||
        task.description !== data.description ||
        task.due_date.getTime() !== new Date(data.due_date).getTime() ||
        task.priority !== data.priority ||
        task.status !== ClientFollowUpTaskStatus.PENDING
      )
        throw new ConflictException(
          'Task id already used; reload to reconcile',
        );
      return task;
    });
  }

  async update(
    clientId: string,
    taskId: string,
    input: UpdateClientFollowUpTaskInput,
    actor: ClientFollowUpTaskActor,
  ): Promise<ClientFollowUpTask> {
    if (
      !Number.isInteger(input.expected_version) ||
      input.expected_version < 1 ||
      input.expected_version > MAX_VERSION
    )
      throw new BadRequestException(
        'Expected version must be a positive PostgreSQL integer',
      );
    const data: Prisma.ClientFollowUpTaskUpdateManyMutationInput =
      this.fields(input);
    if (
      input.status !== undefined &&
      !Object.values(ClientFollowUpTaskStatus).includes(input.status)
    )
      throw new BadRequestException('Invalid task status');
    return this.transaction(async (tx) => {
      await this.scope(tx, clientId, actor, true, input.assigned_to_id);
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM client_followup_tasks WHERE id = ${taskId} AND client_id = ${clientId} FOR UPDATE`,
      );
      const task = await this.owned(tx, clientId, taskId);
      if (
        task.version !== input.expected_version ||
        task.version === MAX_VERSION ||
        task.status === ClientFollowUpTaskStatus.COMPLETED ||
        task.status === ClientFollowUpTaskStatus.CANCELLED
      )
        throw new ConflictException(
          'Task changed or closed; reload before editing',
        );
      const status = input.status ?? task.status;
      data.status = status;
      data.completed_at =
        status === ClientFollowUpTaskStatus.COMPLETED ? new Date() : null;
      data.cancelled_at =
        status === ClientFollowUpTaskStatus.CANCELLED ? new Date() : null;
      data.version = { increment: 1 };
      const result = await tx.clientFollowUpTask.updateMany({
        where: {
          id: taskId,
          client_id: clientId,
          version: input.expected_version,
        },
        data,
      });
      if (result.count !== 1)
        throw new ConflictException('Task changed; reload before editing');
      return this.owned(tx, clientId, taskId);
    });
  }
}
