import { ConflictException } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  ManagedUploadPurpose,
  ManagedUploadStatus,
  PrismaClient,
  ProgressPhotoState,
  ProgressPhotoView,
  Role,
} from '@prisma/client';
import { Pool } from 'pg';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { UploadsService } from '../uploads/uploads.service';
import { ProgressPhotosService } from './progress-photos.service';

const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? '';
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

describeWithDatabase('ProgressPhotosService PostgreSQL concurrency', () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const clientId = `progress-photo-client-${suffix}`;
  const actor: AuthenticatedUser = {
    id: clientId,
    firebase_uid: clientId,
    email: `${clientId}@example.test`,
    role: Role.CLIENT,
  };
  let poolOne: Pool;
  let poolTwo: Pool;
  let prismaOne: PrismaClient;
  let prismaTwo: PrismaClient;
  let serviceOne: ProgressPhotosService;
  let serviceTwo: ProgressPhotosService;

  function createService(prisma: PrismaClient): ProgressPhotosService {
    const uploads = {
      consumePrepared: async (
        tx: PrismaClient,
        ownerId: string,
        uploadId: string,
        purposes: ManagedUploadPurpose[],
      ) => {
        const result = await tx.managedUpload.updateMany({
          where: {
            id: uploadId,
            owner_id: ownerId,
            purpose: { in: purposes },
            status: ManagedUploadStatus.VERIFIED,
            expires_at: { gt: new Date() },
          },
          data: {
            status: ManagedUploadStatus.CONSUMED,
            consumed_at: new Date(),
          },
        });
        if (result.count !== 1) {
          throw new ConflictException({ code: 'UPLOAD_ALREADY_CONSUMED' });
        }
      },
      getProgressPhotoReadUrl: jest
        .fn()
        .mockResolvedValue('https://signed.example.test/photo'),
    };
    return new ProgressPhotosService(
      prisma as unknown as PrismaService,
      uploads as unknown as UploadsService,
    );
  }

  async function createVerifiedUpload(id: string) {
    await prismaOne.managedUpload.create({
      data: {
        id,
        owner_id: clientId,
        purpose: ManagedUploadPurpose.PROGRESS_PHOTO,
        object_key: `progress-photo/${clientId}/${id}.jpg`,
        mime_type: 'image/jpeg',
        expected_bytes: 10,
        actual_bytes: 10,
        status: ManagedUploadStatus.VERIFIED,
        expires_at: new Date(Date.now() + 60_000),
      },
    });
  }

  beforeAll(async () => {
    poolOne = new Pool({ connectionString: testDatabaseUrl });
    poolTwo = new Pool({ connectionString: testDatabaseUrl });
    prismaOne = new PrismaClient({ adapter: new PrismaPg(poolOne) });
    prismaTwo = new PrismaClient({ adapter: new PrismaPg(poolTwo) });
    serviceOne = createService(prismaOne);
    serviceTwo = createService(prismaTwo);
    await prismaOne.user.create({
      data: { id: clientId, email: actor.email, firebase_uid: clientId },
    });
  });

  beforeEach(async () => {
    await prismaOne.progressPhoto.deleteMany({
      where: { client_id: clientId },
    });
    await prismaOne.progressPhotoSession.deleteMany({
      where: { client_id: clientId },
    });
    await prismaOne.managedUpload.deleteMany({ where: { owner_id: clientId } });
  });

  afterAll(async () => {
    await prismaOne?.user.deleteMany({ where: { id: clientId } });
    await prismaOne?.$disconnect();
    await prismaTwo?.$disconnect();
    await poolOne?.end();
    await poolTwo?.end();
  });

  it('serializes competing same-view associations and leaves one active photo', async () => {
    const created = await serviceOne.createSession(actor, clientId, {
      session_date: '2099-01-05',
      operation_id: `session-${suffix}`,
    });
    await Promise.all([
      createVerifiedUpload('upload-one'),
      createVerifiedUpload('upload-two'),
    ]);

    const results = await Promise.allSettled([
      serviceOne.associatePhoto(actor, clientId, created.id, {
        upload_id: 'upload-one',
        view: ProgressPhotoView.FRONT,
        operation_id: `associate-one-${suffix}`,
      }),
      serviceTwo.associatePhoto(actor, clientId, created.id, {
        upload_id: 'upload-two',
        view: ProgressPhotoView.FRONT,
        operation_id: `associate-two-${suffix}`,
      }),
    ]);

    const accepted = results.find(
      (result): result is PromiseFulfilledResult<{ id: string }> =>
        result.status === 'fulfilled',
    );
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(accepted).toMatchObject({
      value: { view: ProgressPhotoView.FRONT },
    });
    expect(rejected?.reason).toMatchObject({
      response: { code: 'PROGRESS_PHOTO_REPLACEMENT_PRECONDITION' },
    });
    const active = await prismaOne.progressPhoto.findFirst({
      where: {
        session_id: created.id,
        view: ProgressPhotoView.FRONT,
        state: ProgressPhotoState.ACTIVE,
      },
    });
    expect(accepted).toMatchObject({
      value: { id: active?.id, view: ProgressPhotoView.FRONT },
    });
    expect(['upload-one', 'upload-two']).toContain(active?.managed_upload_id);
    const uploadStates = await prismaOne.managedUpload.findMany({
      where: { id: { in: ['upload-one', 'upload-two'] } },
      select: { id: true, status: true },
    });
    expect(uploadStates).toHaveLength(2);
    expect(
      uploadStates.filter(
        ({ status }) => status === ManagedUploadStatus.CONSUMED,
      ),
    ).toEqual([
      { id: active?.managed_upload_id, status: ManagedUploadStatus.CONSUMED },
    ]);
    expect(
      uploadStates.filter(
        ({ status }) => status === ManagedUploadStatus.VERIFIED,
      ),
    ).toHaveLength(1);
  });

  it('replays a concurrent association operation without consuming the upload twice', async () => {
    const created = await serviceOne.createSession(actor, clientId, {
      session_date: '2099-01-06',
      operation_id: `session-replay-${suffix}`,
    });
    await createVerifiedUpload('upload-replay');
    const dto = {
      upload_id: 'upload-replay',
      view: ProgressPhotoView.LEFT,
      operation_id: `association-replay-${suffix}`,
    };

    const results = await Promise.all([
      serviceOne.associatePhoto(actor, clientId, created.id, dto),
      serviceTwo.associatePhoto(actor, clientId, created.id, dto),
    ]);
    expect(results[0].id).toBe(results[1].id);
    expect(
      await prismaOne.progressPhoto.count({
        where: { session_id: created.id },
      }),
    ).toBe(1);
    expect(
      await prismaOne.managedUpload.count({
        where: { id: 'upload-replay', status: ManagedUploadStatus.CONSUMED },
      }),
    ).toBe(1);
  });

  it('serializes competing replacements against the named active photo', async () => {
    const created = await serviceOne.createSession(actor, clientId, {
      session_date: '2099-01-07',
      operation_id: `session-replace-${suffix}`,
    });
    await Promise.all(
      ['original', 'replacement-one', 'replacement-two'].map(
        createVerifiedUpload,
      ),
    );
    const original = await serviceOne.associatePhoto(
      actor,
      clientId,
      created.id,
      {
        upload_id: 'original',
        view: ProgressPhotoView.BACK,
        operation_id: `original-${suffix}`,
      },
    );

    const results = await Promise.allSettled([
      serviceOne.associatePhoto(actor, clientId, created.id, {
        upload_id: 'replacement-one',
        view: ProgressPhotoView.BACK,
        operation_id: `replacement-one-${suffix}`,
        replaces_photo_id: original.id,
      }),
      serviceTwo.associatePhoto(actor, clientId, created.id, {
        upload_id: 'replacement-two',
        view: ProgressPhotoView.BACK,
        operation_id: `replacement-two-${suffix}`,
        replaces_photo_id: original.id,
      }),
    ]);

    const accepted = results.find(
      (result): result is PromiseFulfilledResult<{ id: string }> =>
        result.status === 'fulfilled',
    );
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(accepted).toMatchObject({
      value: {
        view: ProgressPhotoView.BACK,
        replaces_photo_id: original.id,
      },
    });
    expect(rejected?.reason).toMatchObject({
      response: { code: 'PROGRESS_PHOTO_REPLACEMENT_PRECONDITION' },
    });
    const active = await prismaOne.progressPhoto.findFirst({
      where: {
        session_id: created.id,
        view: ProgressPhotoView.BACK,
        state: ProgressPhotoState.ACTIVE,
      },
    });
    expect(accepted).toMatchObject({
      value: {
        id: active?.id,
        view: ProgressPhotoView.BACK,
        replaces_photo_id: original.id,
      },
    });
    expect(active?.replaces_photo_id).toBe(original.id);
    expect(
      await prismaOne.progressPhoto.findUnique({ where: { id: original.id } }),
    ).toMatchObject({ state: ProgressPhotoState.REPLACED });
    const replacementUploadStates = await prismaOne.managedUpload.findMany({
      where: { id: { in: ['replacement-one', 'replacement-two'] } },
      select: { id: true, status: true },
    });
    expect(replacementUploadStates).toHaveLength(2);
    expect(
      replacementUploadStates.filter(
        ({ status }) => status === ManagedUploadStatus.CONSUMED,
      ),
    ).toEqual([
      { id: active?.managed_upload_id, status: ManagedUploadStatus.CONSUMED },
    ]);
    expect(
      replacementUploadStates.filter(
        ({ status }) => status === ManagedUploadStatus.VERIFIED,
      ),
    ).toHaveLength(1);
  });
});
