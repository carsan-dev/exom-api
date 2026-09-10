export type DatabaseIdentity = {
  id: string;
  firebase_uid: string;
  email: string;
  is_active: boolean;
  identity_pending: boolean;
};
export type RemoteIdentity = { uid: string; email?: string; disabled: boolean };

export function compareIdentity(
  local: DatabaseIdentity,
  remote: RemoteIdentity | null,
): string[] {
  if (!remote) return ['FIREBASE_MISSING'];
  const findings: string[] = [];
  if (local.firebase_uid !== remote.uid) findings.push('UID_MISMATCH');
  if (local.email.toLowerCase() !== remote.email?.toLowerCase())
    findings.push('EMAIL_MISMATCH');
  if (local.is_active === remote.disabled) findings.push('STATUS_MISMATCH');
  if (local.identity_pending) findings.push('RECOVERY_PENDING');
  return findings;
}
