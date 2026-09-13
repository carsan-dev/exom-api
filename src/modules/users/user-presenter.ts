import type { Role } from '@prisma/client';

type ManagedUserRecord = {
  id: string;
  email: string;
  role: Role;
  is_active: boolean;
  is_locked: boolean;
  created_at: Date;
  login_attempts?: number;
  locked_at?: Date | null;
  firebase_uid?: string;
  profile: {
    first_name: string;
    last_name: string;
    avatar_url: string | null;
  } | null;
};

type ClientAssignmentRecord = {
  client_id: string;
  created_at: Date;
  admin: {
    id: string;
    email: string;
    profile: {
      first_name: string | null;
      last_name: string | null;
      avatar_url: string | null;
    } | null;
  };
};

export function serializeUserSummary(user: ManagedUserRecord) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    is_active: user.is_active,
    is_locked: user.is_locked,
    created_at: user.created_at,
    profile: user.profile,
  };
}

export function buildClientNotificationName(
  user: {
    email?: string | null;
    profile?: {
      first_name?: string | null;
      last_name?: string | null;
    } | null;
  } | null,
) {
  const fullName = [user?.profile?.first_name, user?.profile?.last_name]
    .filter(Boolean)
    .join(' ')
    .trim();

  return fullName || user?.email || 'Cliente';
}

export function serializeClientAssignments(
  clientId: string,
  assignments: ClientAssignmentRecord[],
) {
  return {
    client_id: clientId,
    active_admins: assignments.map((assignment) => ({
      id: assignment.admin.id,
      email: assignment.admin.email,
      profile: assignment.admin.profile,
      assigned_at: assignment.created_at,
    })),
  };
}
