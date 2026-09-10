import { compareIdentity } from './identity-diagnostic';

describe('P5 read-only divergence classification', () => {
  const local = {
    id: 'fixture',
    firebase_uid: 'uid',
    email: 'fixture@example.test',
    is_active: true,
    identity_pending: false,
  };
  it('reports missing, divergent email/state and pending recovery without modifying input', () => {
    expect(compareIdentity(local, null)).toEqual(['FIREBASE_MISSING']);
    expect(
      compareIdentity(local, {
        uid: 'uid',
        email: 'other@example.test',
        disabled: true,
      }),
    ).toEqual(['EMAIL_MISMATCH', 'STATUS_MISMATCH']);
    expect(
      compareIdentity(
        { ...local, identity_pending: true },
        { uid: 'uid', email: local.email.toUpperCase(), disabled: false },
      ),
    ).toEqual(['RECOVERY_PENDING']);
    expect(local.is_active).toBe(true);
  });
});
