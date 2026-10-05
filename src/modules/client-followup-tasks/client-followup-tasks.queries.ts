import { Prisma } from '@prisma/client';
import type { ClientFollowUpTask } from '@prisma/client';

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
  const ordering = Prisma.sql`due_date ASC,
    CASE priority WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 WHEN 'LOW' THEN 2 END ASC,
    created_at ASC, id ASC`;
  const open = Prisma.sql`client_id = ${clientId} AND status IN ('PENDING', 'IN_PROGRESS')`;
  return Prisma.sql`
    (SELECT 'task' AS selector, ${columns} FROM client_followup_tasks
      WHERE ${open} ORDER BY ${ordering} LIMIT 1)
    UNION ALL
    (SELECT 'review' AS selector, ${columns} FROM client_followup_tasks
      WHERE ${open} AND type = 'REVIEW' ORDER BY ${ordering} LIMIT 1)`;
}
