import { Prisma, Role } from '@prisma/client';
import {
  allOf,
  dateRange,
  inList,
  queryPage,
  searchPredicate,
} from '../../common/query-page';
import type { AdminClientsQueryDto } from './dto/admin-clients-query.dto';
import type { AdminUsersQueryDto } from './dto/admin-users-query.dto';

function statusPredicate(status?: string[]) {
  return inList(
    Prisma.sql`CASE WHEN u.is_locked THEN 'LOCKED' WHEN u.is_active THEN 'ACTIVE' ELSE 'INACTIVE' END`,
    status,
  );
}

const searchText = Prisma.sql`concat_ws(' ', NULLIF(u.email, ''), NULLIF(p.first_name, ''), NULLIF(p.last_name, ''))`;
const users = Prisma.sql`users u LEFT JOIN profiles p ON p.user_id = u.id`;
export const activeAdminWhere = {
  is_active: true,
  admin: { is: { role: Role.ADMIN, is_active: true } },
} as const;

export function userPage(
  tx: Prisma.TransactionClient,
  query: AdminUsersQueryDto,
) {
  return queryPage(
    tx,
    Prisma.sql`(SELECT u.id, u.created_at FROM ${users} WHERE ${allOf([
      query.role
        ? Prisma.sql`u.role = ${query.role}::"Role"`
        : Prisma.sql`TRUE`,
      statusPredicate(query.status),
      dateRange(Prisma.sql`u.created_at`, query.created_from, query.created_to),
      searchPredicate(searchText, query.search),
    ])}) q`,
    Prisma.sql`TRUE`,
    Prisma.sql`q.created_at DESC, q.id DESC`,
    query,
  );
}

export function clientPage(
  tx: Prisma.TransactionClient,
  actorId: string,
  role: string,
  query: AdminClientsQueryDto,
) {
  const global = role === Role.SUPER_ADMIN;
  const assigned = Prisma.sql`EXISTS (SELECT 1 FROM admin_client_assignments ca JOIN users a ON a.id = ca.admin_id
    WHERE ca.client_id = u.id AND ca.is_active AND a.role = 'ADMIN' AND a.is_active)`;
  const assignedOnly = query.assignment_state?.includes('ASSIGNED') ?? false;
  const unassignedOnly =
    query.assignment_state?.includes('UNASSIGNED') ?? false;
  const assignmentFilter =
    global && assignedOnly !== unassignedOnly
      ? assignedOnly
        ? assigned
        : Prisma.sql`NOT ${assigned}`
      : Prisma.sql`TRUE`; // Existing ADMIN contract ignores assignment_state.
  const predicates = allOf([
    Prisma.sql`u.role = 'CLIENT'`,
    query.archive && query.archive !== 'all'
      ? Prisma.sql`u.is_archived = ${query.archive === 'archived'}`
      : Prisma.sql`TRUE`,
    inList(Prisma.sql`p.level`, query.level),
    statusPredicate(query.status),
    assignmentFilter,
    dateRange(Prisma.sql`u.created_at`, query.created_from, query.created_to),
    searchPredicate(searchText, query.search),
    global
      ? Prisma.sql`TRUE`
      : Prisma.sql`ca.admin_id = ${actorId} AND ca.is_active`,
  ]);
  const from = global
    ? users
    : Prisma.sql`${users} JOIN admin_client_assignments ca ON ca.client_id = u.id`;
  const orderDate = global
    ? Prisma.sql`u.created_at`
    : Prisma.sql`ca.created_at`;
  const orderId = global ? Prisma.sql`u.id` : Prisma.sql`ca.id`;
  return queryPage(
    tx,
    Prisma.sql`(SELECT u.id, ${orderDate} AS ordered_at, ${orderId} AS ordered_id FROM ${from} WHERE ${predicates}) q`,
    Prisma.sql`TRUE`,
    Prisma.sql`q.ordered_at DESC, q.ordered_id DESC`,
    query,
  );
}
