import { ConflictException, ForbiddenException } from '@nestjs/common';
import {
  ManagedUploadPurpose,
  ProgressPhotoState,
  ProgressPhotoView,
  Role,
} from '@prisma/client';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { UploadsService } from '../uploads/uploads.service';
import { ProgressPhotosService } from './progress-photos.service';

const client: AuthenticatedUser = {
  id: 'client-1',
  firebase_uid: 'firebase-client-1',
  email: 'client-1@example.test',
  role: Role.CLIENT,
};
const assignedAdmin: AuthenticatedUser = {
  id: 'admin-1',
  firebase_uid: 'firebase-admin-1',
  email: 'admin-1@example.test',
  role: Role.ADMIN,
};
const superAdmin: AuthenticatedUser = {
  id: 'super-admin-1',
  firebase_uid: 'firebase-super-admin-1',
  email: 'super-admin-1@example.test',
  role: Role.SUPER_ADMIN,
};

const uploadedPhoto = (overrides: Record<string, unknown> = {}) => ({
  id: 'photo-1',
  session_id: 'session-1',
  client_id: 'client-1',
  uploader_id: 'client-1',
  managed_upload_id: 'upload-1',
  view: ProgressPhotoView.FRONT,
  state: ProgressPhotoState.ACTIVE,
  association_operation_id: 'photo-op-1',
  replaces_photo_id: null,
  created_at: new Date('2026-09-16T10:00:00.000Z'),
  managed_upload: {
    id: 'upload-1',
    object_key: 'progress-photo/client-1/one.jpg',
    mime_type: 'image/jpeg',
    expected_bytes: 100,
    actual_bytes: 100,
  },
  ...overrides,
});

const session = (photos: ReturnType<typeof uploadedPhoto>[] = []) => ({
  id: 'session-1',
  client_id: 'client-1',
  uploader_id: 'client-1',
  session_date: new Date('2026-09-16T00:00:00.000Z'),
  session_operation_id: 'session-op-1',
  created_at: new Date('2026-09-16T10:00:00.000Z'),
  updated_at: new Date('2026-09-16T10:00:00.000Z'),
  photos,
});

type ProgressPhotosPrismaMock = {
  $queryRaw: jest.Mock;
  $transaction: jest.Mock;
  user: { findUnique: jest.Mock };
  adminClientAssignment: { findFirst: jest.Mock };
  progressPhotoSession: {
    findMany: jest.Mock;
    count: jest.Mock;
    findFirst: jest.Mock;
    findUnique: jest.Mock;
    create: jest.Mock;
  };
  progressPhoto: {
    findFirst: jest.Mock;
    findUnique: jest.Mock;
    create: jest.Mock;
    updateMany: jest.Mock;
  };
};

describe('ProgressPhotosService', () => {
  let service: ProgressPhotosService;
  let prisma: ProgressPhotosPrismaMock;
  let uploads: {
    consumePrepared: jest.Mock;
    getProgressPhotoReadUrl: jest.Mock;
    readLocalProgressPhoto: jest.Mock;
  };

  beforeEach(() => {
    prisma = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      $transaction: jest.fn(
        (callback: (tx: ProgressPhotosPrismaMock) => unknown) =>
          callback(prisma),
      ),
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'client-1', role: Role.CLIENT }),
      },
      adminClientAssignment: {
        findFirst: jest.fn().mockResolvedValue({ id: 'assignment-1' }),
      },
      progressPhotoSession: {
        findMany: jest.fn(),
        count: jest.fn(),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
      },
      progressPhoto: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        updateMany: jest.fn(),
      },
    };
    uploads = {
      consumePrepared: jest.fn().mockResolvedValue(undefined),
      getProgressPhotoReadUrl: jest
        .fn()
        .mockResolvedValue('https://signed.example/photo.jpg'),
      readLocalProgressPhoto: jest.fn(),
    };
    service = new ProgressPhotosService(
      prisma as unknown as PrismaService,
      uploads as unknown as UploadsService,
    );
  });

  it('returns bounded deterministic history with incomplete sessions and signed metadata', async () => {
    prisma.progressPhotoSession.findMany.mockResolvedValue([
      session([uploadedPhoto()]),
    ]);
    prisma.progressPhotoSession.count.mockResolvedValue(3);

    await expect(
      service.getHistory(client, 'client-1', { page: 2, limit: 1, skip: 1 }),
    ).resolves.toEqual({
      data: [
        expect.objectContaining({
          id: 'session-1',
          session_date: '2026-09-16',
          is_complete: false,
          photos: [
            expect.objectContaining({
              image_url: 'https://signed.example/photo.jpg',
            }),
          ],
        }),
      ],
      total: 3,
      page: 2,
      limit: 1,
      totalPages: 3,
    });
    expect(prisma.progressPhotoSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ session_date: 'desc' }, { id: 'desc' }],
        skip: 1,
        take: 1,
      }),
    );
    expect(uploads.getProgressPhotoReadUrl).toHaveBeenCalledWith(
      'photo-1',
      'r2://progress-photo/client-1/one.jpg',
    );
  });

  it('allows an assigned admin and a superadmin, but rejects an unassigned admin and another client', async () => {
    prisma.progressPhotoSession.findMany.mockResolvedValue([]);
    prisma.progressPhotoSession.count.mockResolvedValue(0);
    await expect(
      service.getHistory(assignedAdmin, 'client-1', {
        page: 1,
        limit: 20,
        skip: 0,
      }),
    ).resolves.toMatchObject({ total: 0 });
    await expect(
      service.getHistory(superAdmin, 'client-1', {
        page: 1,
        limit: 20,
        skip: 0,
      }),
    ).resolves.toMatchObject({ total: 0 });
    expect(prisma.adminClientAssignment.findFirst).toHaveBeenCalledWith({
      where: { admin_id: 'admin-1', client_id: 'client-1', is_active: true },
      select: { id: true },
    });

    prisma.adminClientAssignment.findFirst.mockResolvedValue(null);
    await expect(
      service.getHistory(assignedAdmin, 'client-1', {
        page: 1,
        limit: 20,
        skip: 0,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.getHistory({ ...client, id: 'client-2' }, 'client-1', {
        page: 1,
        limit: 20,
        skip: 0,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it.each([client, assignedAdmin, superAdmin])(
    'authorizes %s to read a photo file without exposing its storage key',
    async (actor) => {
      prisma.progressPhoto.findUnique.mockResolvedValue({
        client_id: 'client-1',
        managed_upload_id: 'upload-1',
      });
      uploads.readLocalProgressPhoto.mockResolvedValue({
        data: Buffer.from('photo'),
        mimeType: 'image/jpeg',
      });

      await expect(service.readPhotoFile(actor, 'photo-1')).resolves.toEqual({
        data: Buffer.from('photo'),
        mimeType: 'image/jpeg',
      });
      expect(uploads.readLocalProgressPhoto).toHaveBeenCalledWith('upload-1');
    },
  );

  it('rejects cross-client and unassigned-admin direct photo file reads', async () => {
    prisma.progressPhoto.findUnique.mockResolvedValue({
      client_id: 'client-1',
      managed_upload_id: 'upload-1',
    });
    prisma.adminClientAssignment.findFirst.mockResolvedValue(null);

    await expect(
      service.readPhotoFile(assignedAdmin, 'photo-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.readPhotoFile({ ...client, id: 'client-2' }, 'photo-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(uploads.readLocalProgressPhoto).not.toHaveBeenCalled();
  });

  it('creates an incomplete civil-date session and replays the same operation without a second create', async () => {
    prisma.progressPhotoSession.findUnique.mockResolvedValue({
      id: 'session-1',
      client_id: 'client-1',
      session_date: new Date('2026-09-16T00:00:00.000Z'),
    });
    prisma.progressPhotoSession.findFirst.mockResolvedValue(session());

    await expect(
      service.createSession(client, 'client-1', {
        session_date: '2026-09-16',
        operation_id: 'session-op-1',
      }),
    ).resolves.toMatchObject({ id: 'session-1', is_complete: false });
    expect(prisma.progressPhotoSession.create).not.toHaveBeenCalled();
  });

  it('rejects a session replay that changes the target or civil date', async () => {
    prisma.progressPhotoSession.findUnique.mockResolvedValue({
      id: 'session-1',
      client_id: 'client-2',
      session_date: new Date('2026-09-15T00:00:00.000Z'),
    });
    await expect(
      service.createSession(client, 'client-1', {
        session_date: '2026-09-16',
        operation_id: 'session-op-1',
      }),
    ).rejects.toMatchObject({
      response: { code: 'PROGRESS_PHOTO_OPERATION_CONFLICT' },
    });
  });

  it('retries a retryable transaction conflict and preserves the successful session contract', async () => {
    prisma.$transaction
      .mockRejectedValueOnce({ code: 'P2034' })
      .mockImplementationOnce(
        (callback: (tx: ProgressPhotosPrismaMock) => unknown) =>
          callback(prisma),
      );
    prisma.progressPhotoSession.findUnique.mockResolvedValue(null);
    prisma.progressPhotoSession.create.mockResolvedValue({ id: 'session-1' });
    prisma.progressPhotoSession.findFirst.mockResolvedValue(session());

    await expect(
      service.createSession(client, 'client-1', {
        session_date: '2026-09-16',
        operation_id: 'session-op-retry',
      }),
    ).resolves.toMatchObject({ id: 'session-1' });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(prisma.progressPhotoSession.create).toHaveBeenCalledTimes(1);
  });

  it('returns a deterministic conflict after bounded transaction retries', async () => {
    prisma.$transaction.mockRejectedValue({ code: '40001' });

    await expect(
      service.createSession(client, 'client-1', {
        session_date: '2026-09-16',
        operation_id: 'session-op-exhausted',
      }),
    ).rejects.toMatchObject({
      response: { code: 'PROGRESS_PHOTO_CONCURRENCY_CONFLICT' },
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
  });

  it('reconciles a unique same-payload session replay without a duplicate create', async () => {
    prisma.$transaction.mockRejectedValueOnce({ code: 'P2002' });
    prisma.progressPhotoSession.findUnique.mockResolvedValue({
      id: 'session-1',
      client_id: 'client-1',
      session_date: new Date('2026-09-16T00:00:00.000Z'),
    });
    prisma.progressPhotoSession.findFirst.mockResolvedValue(session());

    await expect(
      service.createSession(client, 'client-1', {
        session_date: '2026-09-16',
        operation_id: 'session-op-unique',
      }),
    ).resolves.toMatchObject({ id: 'session-1' });
    expect(prisma.progressPhotoSession.create).not.toHaveBeenCalled();
  });

  it('does not map an unknown database error to a client conflict', async () => {
    const databaseFailure = new Error('database unavailable');
    prisma.$transaction.mockRejectedValue(databaseFailure);

    await expect(
      service.createSession(client, 'client-1', {
        session_date: '2026-09-16',
        operation_id: 'session-op-database-failure',
      }),
    ).rejects.toBe(databaseFailure);
  });

  it('replays a same-payload association before consuming the upload again', async () => {
    prisma.progressPhoto.findUnique.mockResolvedValue(uploadedPhoto());
    prisma.progressPhoto.findFirst.mockResolvedValue(uploadedPhoto());

    await expect(
      service.associatePhoto(client, 'client-1', 'session-1', {
        upload_id: 'upload-1',
        view: ProgressPhotoView.FRONT,
        operation_id: 'photo-op-1',
      }),
    ).resolves.toMatchObject({
      id: 'photo-1',
      state: ProgressPhotoState.ACTIVE,
    });
    expect(uploads.consumePrepared).not.toHaveBeenCalled();
    expect(prisma.progressPhoto.create).not.toHaveBeenCalled();
  });

  it('rejects a changed association payload for the same operation', async () => {
    prisma.progressPhoto.findUnique.mockResolvedValue(uploadedPhoto());
    await expect(
      service.associatePhoto(client, 'client-1', 'session-1', {
        upload_id: 'upload-2',
        view: ProgressPhotoView.FRONT,
        operation_id: 'photo-op-1',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(uploads.consumePrepared).not.toHaveBeenCalled();
  });

  it('requires the active photo as a replacement precondition and leaves it active on failure', async () => {
    prisma.progressPhoto.findUnique.mockResolvedValue(null);
    prisma.progressPhotoSession.findFirst.mockResolvedValue({
      id: 'session-1',
    });
    prisma.progressPhoto.findFirst.mockResolvedValue({ id: 'active-photo-1' });

    await expect(
      service.associatePhoto(client, 'client-1', 'session-1', {
        upload_id: 'upload-2',
        view: ProgressPhotoView.FRONT,
        operation_id: 'photo-op-2',
      }),
    ).rejects.toMatchObject({
      response: { code: 'PROGRESS_PHOTO_REPLACEMENT_PRECONDITION' },
    });
    expect(prisma.progressPhoto.updateMany).not.toHaveBeenCalled();
    expect(uploads.consumePrepared).not.toHaveBeenCalled();
  });

  it('replaces exactly the named active view then consumes one verified progress-photo upload', async () => {
    prisma.progressPhoto.findUnique.mockResolvedValue(null);
    prisma.progressPhotoSession.findFirst.mockResolvedValue({
      id: 'session-1',
    });
    prisma.progressPhoto.findFirst
      .mockResolvedValueOnce({ id: 'active-photo-1' })
      .mockResolvedValueOnce(
        uploadedPhoto({
          id: 'photo-2',
          managed_upload_id: 'upload-2',
          replaces_photo_id: 'active-photo-1',
        }),
      );
    prisma.progressPhoto.updateMany.mockResolvedValue({ count: 1 });
    prisma.progressPhoto.create.mockResolvedValue({ id: 'photo-2' });

    await expect(
      service.associatePhoto(client, 'client-1', 'session-1', {
        upload_id: 'upload-2',
        view: ProgressPhotoView.FRONT,
        operation_id: 'photo-op-2',
        replaces_photo_id: 'active-photo-1',
      }),
    ).resolves.toMatchObject({
      id: 'photo-2',
      replaces_photo_id: 'active-photo-1',
    });
    expect(prisma.progressPhoto.updateMany).toHaveBeenCalledWith({
      where: { id: 'active-photo-1', state: ProgressPhotoState.ACTIVE },
      data: { state: ProgressPhotoState.REPLACED },
    });
    expect(uploads.consumePrepared).toHaveBeenCalledWith(
      prisma,
      'client-1',
      'upload-2',
      [ManagedUploadPurpose.PROGRESS_PHOTO],
    );
  });
});
