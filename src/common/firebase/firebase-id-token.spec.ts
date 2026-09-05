import { Logger } from '@nestjs/common';
import {
  FirebaseIdTokenRejectedError,
  verifyFirebaseIdTokenWithFallback,
} from './firebase-id-token';

const verifyIdTokenMock = jest.fn();
const fetchMock = jest.fn();
const loggerErrorMock = jest.fn();
const loggerWarnMock = jest.fn();

jest.mock('firebase-admin', () => ({
  auth: () => ({ verifyIdToken: verifyIdTokenMock }),
}));

describe('verifyFirebaseIdTokenWithFallback', () => {
  const logger = {
    error: loggerErrorMock,
    warn: loggerWarnMock,
  } as unknown as Logger;

  beforeEach(() => {
    verifyIdTokenMock.mockReset();
    fetchMock.mockReset();
    loggerErrorMock.mockReset();
    loggerWarnMock.mockReset();
    global.fetch = fetchMock;
  });

  it('uses Admin SDK even when FIREBASE_WEB_API_KEY exists', async () => {
    verifyIdTokenMock.mockResolvedValue({
      uid: 'firebase-user-1',
      email: 'client@exom.dev',
    });

    await expect(
      verifyFirebaseIdTokenWithFallback({
        token: 'id-token',
        webApiKey: 'web-api-key',
        logger,
        logContext: 'test',
      }),
    ).resolves.toEqual({
      uid: 'firebase-user-1',
      email: 'client@exom.dev',
    });

    expect(verifyIdTokenMock).toHaveBeenCalledWith('id-token');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not hide an Admin SDK failure behind REST by default', async () => {
    const verificationError = new Error('invalid token');
    verifyIdTokenMock.mockRejectedValue(verificationError);

    await expect(
      verifyFirebaseIdTokenWithFallback({
        token: 'bad-token',
        webApiKey: 'web-api-key',
        logger,
        logContext: 'test',
      }),
    ).rejects.toBe(verificationError);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses accounts:lookup only when the emergency fallback is explicit', async () => {
    verifyIdTokenMock.mockRejectedValue(new Error('admin unavailable'));
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          users: [
            {
              localId: 'firebase-google-1',
              email: 'client@exom.dev',
            },
          ],
        }),
    });

    await expect(
      verifyFirebaseIdTokenWithFallback({
        token: 'id-token',
        webApiKey: 'web-api-key',
        restFallbackEnabled: true,
        logger,
        logContext: 'test',
      }),
    ).resolves.toEqual({
      uid: 'firebase-google-1',
      email: 'client@exom.dev',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(loggerWarnMock).toHaveBeenCalledWith(
      'test: using explicitly enabled Firebase REST token fallback',
    );
  });

  it('does not use REST fallback for provider-sensitive verification', async () => {
    const verificationError = Object.assign(new Error('admin unavailable'), {
      code: 'auth/internal-error',
    });
    verifyIdTokenMock.mockRejectedValue(verificationError);

    await expect(
      verifyFirebaseIdTokenWithFallback({
        token: 'social-token',
        webApiKey: 'web-api-key',
        restFallbackEnabled: true,
        logger,
        logContext: 'test',
        expectedProvider: 'google.com',
      }),
    ).rejects.toBe(verificationError);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      'test: Firebase REST token fallback skipped for provider-sensitive verification',
    );
  });

  it('preserves a concrete REST token rejection as an auth rejection', async () => {
    verifyIdTokenMock.mockRejectedValue(
      Object.assign(new Error('invalid token'), {
        code: 'auth/invalid-id-token',
      }),
    );
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: () => Promise.resolve({ error: { message: 'INVALID_ID_TOKEN' } }),
    });

    await expect(
      verifyFirebaseIdTokenWithFallback({
        token: 'bad-token',
        webApiKey: 'web-api-key',
        restFallbackEnabled: true,
        logger,
        logContext: 'test',
      }),
    ).rejects.toBeInstanceOf(FirebaseIdTokenRejectedError);
  });
});
