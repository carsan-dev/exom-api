import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ManagedUploadPurpose,
  ManagedUploadStatus,
  Role,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { UploadsService } from './uploads.service';

describe('UploadsService', () => {
  const configValues: Record<string, string> = {
    NODE_ENV: 'production',
    R2_BUCKET_NAME: 'test-bucket',
    R2_PUBLIC_URL: 'https://cdn.exom.test',
    R2_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
    R2_ACCESS_KEY_ID: 'test-access-key',
    R2_SECRET_ACCESS_KEY: 'test-secret-key',
  };
  const config = {
    get: jest.fn((key: string, fallback?: string) =>
      configValues[key] ?? fallback,
    ),
  };
  const managedUpload = {
    count: jest.fn(),
    create: jest.fn(),
    findMany: jest.fn(),
    findFirst: jest.fn(),
    findUniqueOrThrow: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  };
  const prisma = {
    managedUpload,
    $queryRaw: jest.fn(),
    $transaction: jest.fn(),
  };
  let service: UploadsService;

  const session = (status = ManagedUploadStatus.VERIFIED) => ({
    id: 'upload-1',
    owner_id: 'client-1',
    approval_request_id: null,
    purpose: ManagedUploadPurpose.FEEDBACK_VIDEO,
    object_key: 'feedback-video/client-1/file.mp4',
    mime_type: 'video/mp4',
    expected_bytes: 12,
    actual_bytes: 12,
    status,
    expires_at: new Date(Date.now() + 60_000),
    verified_at: status === ManagedUploadStatus.VERIFIED ? new Date() : null,
    consumed_at: null,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation((callback) => callback(prisma));
    service = new UploadsService(
      config as unknown as ConfigService,
      prisma as unknown as PrismaService,
    );
  });

  it('rejects a MIME that is incompatible with the purpose', async () => {
    await expect(
      service.createSession('client-1', Role.CLIENT, {
        purpose: ManagedUploadPurpose.FEEDBACK_VIDEO,
        mimeType: 'image/png',
        bytes: 100,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(managedUpload.create).not.toHaveBeenCalled();
  });

  it('enforces the per-purpose byte limit', async () => {
    await expect(
      service.createSession('client-1', Role.CLIENT, {
        purpose: ManagedUploadPurpose.FEEDBACK_VIDEO,
        mimeType: 'video/mp4',
        bytes: 100 * 1024 * 1024 + 1,
      }),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
    expect(managedUpload.create).not.toHaveBeenCalled();
  });

  it('prevents clients from creating admin content uploads', async () => {
    await expect(
      service.createSession('client-1', Role.CLIENT, {
        purpose: ManagedUploadPurpose.EXERCISE_VIDEO,
        mimeType: 'video/mp4',
        bytes: 100,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects arbitrary URLs and uploads owned by another user', async () => {
    managedUpload.findFirst.mockResolvedValue(null);

    await expect(
      service.prepareForConsumption({
        ownerId: 'client-2',
        uploadId: 'upload-1',
        purposes: [ManagedUploadPurpose.FEEDBACK_VIDEO],
      }),
    ).rejects.toMatchObject({ response: { code: 'MANAGED_UPLOAD_REQUIRED' } });
    await expect(
      service.prepareForConsumption({
        ownerId: 'client-1',
        legacyUrl: 'https://attacker.example/fake.mp4',
        purposes: [ManagedUploadPurpose.FEEDBACK_VIDEO],
      }),
    ).rejects.toMatchObject({ response: { code: 'MANAGED_UPLOAD_REQUIRED' } });
  });

  it('completes an upload idempotently after validating its signature', async () => {
    const pending = session(ManagedUploadStatus.PENDING);
    const verified = session(ManagedUploadStatus.VERIFIED);
    managedUpload.findFirst
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(verified);
    managedUpload.findUniqueOrThrow.mockResolvedValue(verified);
    managedUpload.updateMany.mockResolvedValue({ count: 1 });
    const inspect = jest
      .spyOn(service as any, 'inspectObject')
      .mockResolvedValue({
        bytes: 12,
        mimeType: 'video/mp4',
        header: Buffer.from([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0]),
      });

    await expect(
      service.completeSession('client-1', 'upload-1'),
    ).resolves.toMatchObject({
      upload_id: 'upload-1',
      status: ManagedUploadStatus.VERIFIED,
    });
    await expect(
      service.completeSession('client-1', 'upload-1'),
    ).resolves.toMatchObject({ upload_id: 'upload-1' });

    expect(inspect).toHaveBeenCalledTimes(1);
    expect(managedUpload.updateMany).toHaveBeenCalledTimes(1);
  });

  it('allows only one concurrent consumer of a verified session', async () => {
    managedUpload.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    const settled = await Promise.allSettled([
      service.consumePrepared(
        prisma as any,
        'client-1',
        'upload-1',
        [ManagedUploadPurpose.FEEDBACK_VIDEO],
      ),
      service.consumePrepared(
        prisma as any,
        'client-1',
        'upload-1',
        [ManagedUploadPurpose.FEEDBACK_VIDEO],
      ),
    ]);

    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = settled.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(rejected?.reason).toBeInstanceOf(ConflictException);
  });

  it('consumes only a matching reserved approval even after 24 hours', async () => {
    managedUpload.findFirst.mockResolvedValue({
      ...session(ManagedUploadStatus.RESERVED),
      approval_request_id: 'approval-1',
      expires_at: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });
    managedUpload.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      service.prepareForConsumption({
        ownerId: 'client-1',
        uploadId: 'upload-1',
        purposes: [ManagedUploadPurpose.FEEDBACK_VIDEO],
        approvalRequestId: 'approval-1',
      }),
    ).resolves.toMatchObject({ id: 'upload-1' });
    await expect(
      service.consumePrepared(
        prisma as any,
        'client-1',
        'upload-1',
        [ManagedUploadPurpose.FEEDBACK_VIDEO],
        'approval-1',
      ),
    ).resolves.toBeUndefined();

    expect(managedUpload.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            {
              status: ManagedUploadStatus.RESERVED,
              approval_request_id: 'approval-1',
            },
          ]),
        }),
      }),
    );
  });

  it('accepts WebM with an EBML signature', async () => {
    const webm = {
      ...session(ManagedUploadStatus.PENDING),
      mime_type: 'video/webm',
      object_key: 'feedback-video/client-1/file.webm',
    };
    managedUpload.findFirst.mockResolvedValue(webm);
    managedUpload.findUniqueOrThrow.mockResolvedValue({
      ...webm,
      status: ManagedUploadStatus.VERIFIED,
    });
    managedUpload.updateMany.mockResolvedValue({ count: 1 });
    jest.spyOn(service as any, 'inspectObject').mockResolvedValue({
      bytes: 12,
      mimeType: 'video/webm',
      header: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]),
    });

    await expect(service.completeSession('client-1', webm.id)).resolves.toMatchObject({
      content_type: 'video/webm',
    });
  });

  it('normalizes signed managed URLs before comparing references', async () => {
    managedUpload.findFirst.mockResolvedValue({ id: 'upload-1' });
    const signed =
      'https://test-bucket.account.r2.cloudflarestorage.com/feedback-video/client-1/file.mp4?X-Amz-Signature=abc#fragment';

    await expect(
      service.isConsumedManagedUrl('client-1', signed, [
        ManagedUploadPurpose.FEEDBACK_VIDEO,
      ]),
    ).resolves.toBe(true);
    expect(managedUpload.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        object_key: 'feedback-video/client-1/file.mp4',
      }),
      select: { id: true },
    });
    expect(
      service.referencesSame(
        'r2://feedback-video/client-1/file.mp4',
        signed,
      ),
    ).toBe(true);
  });

  it('purges failed sessions even before their normal expiry', async () => {
    const failed = session(ManagedUploadStatus.FAILED);
    managedUpload.findMany.mockResolvedValue([failed]);
    managedUpload.updateMany.mockResolvedValue({ count: 1 });
    jest.spyOn(service as any, 'deleteManagedObject').mockResolvedValue(undefined);

    await expect(service.purgeExpiredSessions()).resolves.toBe(1);
    expect(managedUpload.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: ManagedUploadStatus.EXPIRED } }),
    );
  });

  it('serializes the active-session quota per owner', async () => {
    let active = 19;
    let transactionTail = Promise.resolve();
    prisma.$transaction.mockImplementation((callback) => {
      const run = transactionTail.then(() => callback(prisma));
      transactionTail = run.then(() => undefined, () => undefined);
      return run;
    });
    managedUpload.count.mockImplementation(() => Promise.resolve(active));
    managedUpload.create.mockImplementation(({ data }) => {
      active++;
      return Promise.resolve({ ...session(ManagedUploadStatus.PENDING), ...data });
    });

    const results = await Promise.allSettled([
      service.createSession('client-1', Role.CLIENT, {
        purpose: ManagedUploadPurpose.FEEDBACK_VIDEO,
        mimeType: 'video/mp4',
        bytes: 12,
      }),
      service.createSession('client-1', Role.CLIENT, {
        purpose: ManagedUploadPurpose.FEEDBACK_VIDEO,
        mimeType: 'video/mp4',
        bytes: 12,
      }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });
});
