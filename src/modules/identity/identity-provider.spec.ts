import { IdentityProvider } from './identity-provider';

const getUser = jest.fn();
const deleteUser = jest.fn();
const createUser = jest.fn();
const updateUser = jest.fn();
const revokeRefreshTokens = jest.fn();
jest.mock('firebase-admin', () => ({
  auth: () => ({
    getUser,
    deleteUser,
    createUser,
    updateUser,
    revokeRefreshTokens,
  }),
}));

describe('P5 Firebase identity adapter (simulated)', () => {
  const provider = new IdentityProvider();
  beforeEach(() => jest.resetAllMocks());
  it('treats missing users as absent but preserves lookup failures', async () => {
    getUser.mockRejectedValueOnce({ code: 'auth/user-not-found' });
    await expect(provider.get('fixture')).resolves.toBeNull();
    getUser.mockRejectedValueOnce({ code: 'auth/internal-error' });
    await expect(provider.get('fixture')).rejects.toMatchObject({
      code: 'auth/internal-error',
    });
  });
  it('retries a missing deletion and verifies absence', async () => {
    deleteUser.mockRejectedValueOnce({ code: 'auth/user-not-found' });
    getUser.mockRejectedValueOnce({ code: 'auth/user-not-found' });
    await expect(provider.remove('fixture')).resolves.toBeUndefined();
    expect(getUser).toHaveBeenCalledWith('fixture');
  });
  it('does not confirm compensation if Firebase still has the identity', async () => {
    deleteUser.mockResolvedValue(undefined);
    getUser.mockResolvedValue({ uid: 'fixture' });
    await expect(provider.remove('fixture')).rejects.toThrow(
      'IDENTITY_STILL_EXISTS',
    );
  });
  it.each(['delete', 'verify'])(
    'propagates a failure during %s compensation',
    async (stage) => {
      if (stage === 'delete')
        deleteUser.mockRejectedValue({ code: 'auth/insufficient-permission' });
      else {
        deleteUser.mockResolvedValue(undefined);
        getUser.mockRejectedValue({ code: 'auth/insufficient-permission' });
      }
      await expect(provider.remove('fixture')).rejects.toMatchObject({
        code: 'auth/insufficient-permission',
      });
    },
  );
  it('uses the journal UID for creation and forwards update/revocation failures', async () => {
    createUser.mockResolvedValue({ uid: 'reserved-uid' });
    await provider.create({
      uid: 'reserved-uid',
      email: 'fixture@example.test',
      password: 'fixture-password',
    });
    expect(createUser).toHaveBeenCalledWith(
      expect.objectContaining({ uid: 'reserved-uid' }),
    );
    updateUser.mockRejectedValue({ code: 'auth/email-already-exists' });
    await expect(
      provider.update('reserved-uid', { email: 'taken@example.test' }),
    ).rejects.toMatchObject({ code: 'auth/email-already-exists' });
    revokeRefreshTokens.mockRejectedValue({
      code: 'auth/insufficient-permission',
    });
    await expect(provider.revoke('reserved-uid')).rejects.toMatchObject({
      code: 'auth/insufficient-permission',
    });
  });
});
