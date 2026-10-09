import { Prisma, Role } from '@prisma/client';
import type { ClientFollowUpTask } from '@prisma/client';
import type {
  ClientFollowUpTaskListDto,
  FollowUpPageDto,
} from './dto/client-followup-task-list.dto';

// Same eligibility flags and assignment rule used by the locked writer.
export const eligibleStaffFlags = {
  is_active: true,
  is_locked: false,
  is_archived: false,
  identity_pending: false,
} as const;
export function requiresClientAssignment(role: string): boolean {
  return role === Role.ADMIN;
}
export const staffRoles: readonly Role[] = [Role.ADMIN, Role.SUPER_ADMIN];

export interface AssigneeDisplay {
  id: string;
  display_name: string | null;
}
export interface ListedTask extends Omit<
  ClientFollowUpTask,
  | 'client_id'
  | 'created_by_id'
  | 'due_date'
  | 'created_at'
  | 'updated_at'
  | 'completed_at'
  | 'cancelled_at'
> {
  due_date: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  cancelled_at: string | null;
  assignee: AssigneeDisplay | null;
}
export interface PageSnapshot<T> {
  total: bigint;
  data: T[];
}
const taskOrdering = Prisma.sql`due_date ASC,
  CASE priority WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 WHEN 'LOW' THEN 2 END ASC,
  created_at ASC, id ASC`;

// Both total and bounded page are evaluated in one statement/read snapshot,
// including an empty page beyond the last item. No JSON aggregation of all rows.
function pageQuery(
  source: Prisma.Sql,
  ordering: Prisma.Sql,
  page: FollowUpPageDto,
): Prisma.Sql {
  return Prisma.sql`WITH filtered AS NOT MATERIALIZED (${source}),
    page AS (SELECT * FROM filtered ORDER BY ${ordering} LIMIT ${page.limit} OFFSET ${(page.page - 1) * page.limit})
    SELECT (SELECT count(*) FROM filtered) AS total,
      COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY ${ordering}) FROM page), '[]'::jsonb) AS data`;
}
export function taskListQuery(
  clientId: string,
  query: ClientFollowUpTaskListDto,
): Prisma.Sql {
  const view = query.view ?? (query.status ? 'all' : 'active');
  const filters = [Prisma.sql`t.client_id = ${clientId}`];
  if (view === 'active')
    filters.push(Prisma.sql`t.status IN ('PENDING', 'IN_PROGRESS')`);
  if (view === 'history')
    filters.push(Prisma.sql`t.status IN ('COMPLETED', 'CANCELLED')`);
  if (query.status)
    filters.push(
      Prisma.sql`t.status = ${query.status}::"ClientFollowUpTaskStatus"`,
    );
  if (query.assigned_to_id === 'unassigned')
    filters.push(Prisma.sql`t.assigned_to_id IS NULL`);
  else if (query.assigned_to_id)
    filters.push(
      Prisma.sql`t.assigned_to_id = ${query.assigned_to_id.toLowerCase()}`,
    );
  return pageQuery(
    Prisma.sql`SELECT t.id, t.title, t.description, t.type, t.due_date,
    t.priority, t.status, t.version, t.created_at, t.updated_at, t.completed_at, t.cancelled_at,
    t.assigned_to_id, CASE WHEN u.id IS NULL THEN NULL ELSE jsonb_build_object('id', u.id,
      'display_name', NULLIF(trim(concat_ws(' ', p.first_name, p.last_name)), '')) END AS assignee
    FROM client_followup_tasks t LEFT JOIN users u ON u.id = t.assigned_to_id
    LEFT JOIN profiles p ON p.user_id = u.id WHERE ${Prisma.join(filters, ' AND ')}`,
    taskOrdering,
    query,
  );
}
export function assigneesQuery(
  clientId: string,
  query: FollowUpPageDto,
): Prisma.Sql {
  // Generate the branch from the writer's role rule, not a second hand-maintained matrix.
  const roles = staffRoles.map((role) =>
    requiresClientAssignment(role)
      ? Prisma.sql`(u.role = ${role}::"Role" AND EXISTS (SELECT 1 FROM admin_client_assignments a
        WHERE a.admin_id = u.id AND a.client_id = ${clientId} AND a.is_active = true))`
      : Prisma.sql`u.role = ${role}::"Role"`,
  );
  return pageQuery(
    Prisma.sql`SELECT u.id,
    NULLIF(trim(concat_ws(' ', p.first_name, p.last_name)), '') AS display_name
    FROM users u LEFT JOIN profiles p ON p.user_id = u.id
    WHERE u.is_active = ${eligibleStaffFlags.is_active} AND u.is_locked = ${eligibleStaffFlags.is_locked}
      AND u.is_archived = ${eligibleStaffFlags.is_archived} AND u.identity_pending = ${eligibleStaffFlags.identity_pending}
      AND (${Prisma.join(roles, ' OR ')})`,
    Prisma.sql`display_name ASC NULLS LAST, id ASC`,
    query,
  );
}

export type NextTaskRow = Pick<
  ClientFollowUpTask,
  | 'id'
  | 'type'
  | 'title'
  | 'due_date'
  | 'priority'
  | 'assigned_to_id'
  | 'version'
>;

export interface SelectedNextTask extends NextTaskRow {
  selector: string;
}

// One statement = one PostgreSQL read snapshot for both independent selectors.
// Explicit CASE rank deliberately does not depend on enum declaration order.
export function nextTasksQuery(clientId: string): Prisma.Sql {
  const columns = Prisma.sql`id, type, title, due_date, priority, assigned_to_id, version`;
  const ordering = taskOrdering;
  const open = Prisma.sql`client_id = ${clientId} AND status IN ('PENDING', 'IN_PROGRESS')`;
  return Prisma.sql`
    (SELECT 'task' AS selector, ${columns} FROM client_followup_tasks
      WHERE ${open} ORDER BY ${ordering} LIMIT 1)
    UNION ALL
    (SELECT 'review' AS selector, ${columns} FROM client_followup_tasks
      WHERE ${open} AND type = 'REVIEW' ORDER BY ${ordering} LIMIT 1)`;
}
