import { ConfigService } from '@nestjs/config';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { PrismaService } from '../../prisma/prisma.service';
import { UploadsService } from '../uploads/uploads.service';
import { DeletionIdentityService } from './client-deletion.service';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const sendObject = jest.fn<Promise<unknown>, [unknown]>();
jest.mock('@aws-sdk/client-s3', () => ({
  ...jest.requireActual<typeof import('@aws-sdk/client-s3')>(
    '@aws-sdk/client-s3',
  ),
  S3Client: class {
    send = sendObject;
  },
}));
const deleteUser = jest.fn();
const getUser = jest.fn();
let initialized = true;
jest.mock('firebase-admin', () => ({
  get apps() {
    return initialized ? ['simulated-app'] : [];
  },
  auth: () => ({ deleteUser, getUser }),
}));

describe('F004 external verification adapters (no real services)', () => {
  beforeEach(() => {
    initialized = true;
    jest.resetAllMocks();
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });
  it('rejects uninitialized Firebase instead of returning success', async () => {
    initialized = false;
    await expect(
      new DeletionIdentityService().remove('fixture'),
    ).rejects.toThrow('IDENTITY_UNAVAILABLE');
    expect(deleteUser).not.toHaveBeenCalled();
  });
  it('does not infer local storage ownership from development mode or missing configuration', async () => {
    const service = new UploadsService(
      new ConfigService({
        NODE_ENV: 'development',
        R2_ENDPOINT: 'http://127.0.0.1:1',
      }),
      {} as PrismaService,
    );
    expect(service.requiresDeletionDrainReview()).toBe(true);
    await expect(
      service.deleteAndVerifyForClientDeletion(
        'feedback-video/fixture/test.mp4',
      ),
    ).rejects.toThrow('STORAGE_UNAVAILABLE');
    expect(sendObject).not.toHaveBeenCalled();
  });
  it('accepts an already missing identity only after verifying it is absent', async () => {
    deleteUser.mockRejectedValue({ code: 'auth/user-not-found' });
    getUser.mockRejectedValue({ code: 'auth/user-not-found' });
    await expect(
      new DeletionIdentityService().remove('fixture'),
    ).resolves.toBeUndefined();
    expect(getUser).toHaveBeenCalledWith('fixture');
  });
  it.each(['auth/internal-error', 'auth/insufficient-permission'])(
    'preserves identity errors %s',
    async (code) => {
      deleteUser.mockRejectedValue({ code });
      await expect(
        new DeletionIdentityService().remove('fixture'),
      ).rejects.toMatchObject({ code });
    },
  );
  it('rejects an identity still visible after deletion', async () => {
    getUser.mockResolvedValue({ uid: 'fixture' });
    await expect(
      new DeletionIdentityService().remove('fixture'),
    ).rejects.toThrow('IDENTITY_STILL_EXISTS');
  });
  it.each([404, 403, 500, 200])(
    'verifies storage absence and distinguishes HEAD %s',
    async (status) => {
      // This exercises DELETE/HEAD handling, not R2 in-flight completion timing.
      sendObject.mockImplementation((command) => {
        if (command instanceof HeadObjectCommand && status !== 200)
          return Promise.reject(
            Object.assign(new Error('simulated storage response'), {
              $metadata: { httpStatusCode: status },
            }),
          );
        return Promise.resolve({ $metadata: { httpStatusCode: 200 } });
      });
      const service = new UploadsService(
        new ConfigService({
          NODE_ENV: 'production',
          R2_BUCKET_NAME: 'isolated-test-bucket',
          R2_ENDPOINT: 'http://127.0.0.1:1',
        }),
        {} as PrismaService,
      );
      const key = `feedback-video/${randomUUID()}/test.mp4`;
      expect(existsSync(join(process.cwd(), 'uploads', key))).toBe(false);
      const result = service.deleteAndVerifyForClientDeletion(key);
      if (status === 404) await expect(result).resolves.toBeUndefined();
      else await expect(result).rejects.toBeDefined();
      expect(sendObject).toHaveBeenCalledTimes(2);
    },
  );
});
