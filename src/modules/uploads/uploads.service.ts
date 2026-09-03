import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import {
  ManagedUploadPurpose,
  ManagedUploadStatus,
  Prisma,
  PrismaClient,
  Role,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaService } from '../../prisma/prisma.service';

type TransactionClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const VIDEO_MIME_TYPES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/x-m4v',
  'video/webm',
]);
const IMAGE_LIMIT = 10 * 1024 * 1024;
const FEEDBACK_VIDEO_LIMIT = 100 * 1024 * 1024;
const EXERCISE_VIDEO_LIMIT = 250 * 1024 * 1024;
const MAX_ACTIVE_SESSIONS = 20;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const PRESIGNED_TTL_SECONDS = 15 * 60;

interface SessionRequest {
  purpose: ManagedUploadPurpose;
  mimeType: string;
  bytes?: number;
}

@Injectable()
export class UploadsService {
  private readonly s3Client: S3Client;
  private readonly bucket: string;
  private readonly publicUrl: string;
  private readonly endpoint: string;
  private readonly isDev: boolean;
  private readonly localUploadsDir: string;
  private readonly signedReadExpiresIn: number;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.bucket = this.config.get<string>('R2_BUCKET_NAME', '');
    this.publicUrl = this.config.get<string>('R2_PUBLIC_URL', '');
    this.endpoint = this.config.get<string>('R2_ENDPOINT', '');
    this.isDev = this.config.get<string>('NODE_ENV') !== 'production';
    this.localUploadsDir = path.join(process.cwd(), 'uploads');
    this.signedReadExpiresIn = parseInt(
      this.config.get<string>('R2_SIGNED_READ_EXPIRES_SECONDS', '21600'),
      10,
    );
    this.s3Client = new S3Client({
      region: 'auto',
      endpoint: this.endpoint,
      credentials: {
        accessKeyId: this.config.get<string>('R2_ACCESS_KEY_ID', ''),
        secretAccessKey: this.config.get<string>('R2_SECRET_ACCESS_KEY', ''),
      },
    });
  }

  async createSession(ownerId: string, role: string, request: SessionRequest) {
    this.assertPurposeAllowed(role, request.purpose);
    const mimeType = this.normalizeMime(request.mimeType);
    const limit = this.limitFor(request.purpose);
    this.assertMimeAllowed(request.purpose, mimeType);
    const expectedBytes = request.bytes ?? limit;
    if (!Number.isInteger(expectedBytes) || expectedBytes <= 0) {
      throw new BadRequestException('bytes debe ser un entero positivo');
    }
    if (expectedBytes > limit) {
      throw new PayloadTooLargeException({
        code: 'UPLOAD_TOO_LARGE',
        message: `El archivo supera el límite de ${Math.floor(limit / 1024 / 1024)} MB`,
      });
    }

    const objectKey = `${this.prefixFor(request.purpose)}/${ownerId}/${randomUUID()}${this.extensionFor(mimeType)}`;
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    const session = await this.prisma.$transaction(async (tx) => {
      // Serialize the quota check per owner. A count followed by create without
      // this row lock lets concurrent requests exceed MAX_ACTIVE_SESSIONS.
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "users" WHERE "id" = ${ownerId} FOR UPDATE`,
      );
      const activeCount = await tx.managedUpload.count({
        where: {
          owner_id: ownerId,
          status: {
            in: [
              ManagedUploadStatus.PENDING,
              ManagedUploadStatus.VERIFIED,
              ManagedUploadStatus.RESERVED,
            ],
          },
          OR: [
            { status: ManagedUploadStatus.RESERVED },
            { expires_at: { gt: new Date() } },
          ],
        },
      });
      if (activeCount >= MAX_ACTIVE_SESSIONS) {
        throw new ConflictException({
          code: 'UPLOAD_SESSION_LIMIT',
          message: 'Tienes demasiadas subidas activas; completa o elimina alguna',
        });
      }
      return tx.managedUpload.create({
        data: {
          owner_id: ownerId,
          purpose: request.purpose,
          object_key: objectKey,
          mime_type: mimeType,
          expected_bytes: expectedBytes,
          expires_at: expiresAt,
        },
      });
    });
    const uploadUrl = await getSignedUrl(
      this.s3Client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
        ContentType: mimeType,
      }),
      { expiresIn: PRESIGNED_TTL_SECONDS },
    );

    return {
      upload_id: session.id,
      upload_url: uploadUrl,
      file_url: this.buildStoredFileUrl(objectKey),
      expires_at: expiresAt,
      presigned_expires_at: new Date(
        Date.now() + PRESIGNED_TTL_SECONDS * 1000,
      ),
      max_bytes: limit,
      content_type: mimeType,
    };
  }

  async completeSession(ownerId: string, sessionId: string) {
    const session = await this.prisma.managedUpload.findFirst({
      where: { id: sessionId, owner_id: ownerId },
    });
    if (!session) throw new NotFoundException('Sesión de subida no encontrada');
    if (
      session.status === ManagedUploadStatus.CONSUMED ||
      session.status === ManagedUploadStatus.VERIFIED
    ) {
      return this.serializeSession(session);
    }
    if (session.status !== ManagedUploadStatus.PENDING) {
      throw new ConflictException('La sesión ya no admite verificaciones');
    }
    if (session.expires_at <= new Date()) {
      await this.prisma.managedUpload.update({
        where: { id: session.id },
        data: { status: ManagedUploadStatus.EXPIRED },
      });
      throw new ConflictException({
        code: 'UPLOAD_EXPIRED',
        message: 'La sesión de subida ha caducado',
      });
    }

    let inspected: { bytes: number; mimeType: string; header: Buffer };
    try {
      inspected = await this.inspectObject(session.object_key);
    } catch (error) {
      await this.failSession(session.id, session.object_key);
      throw error;
    }
    const expectedIsLegacyMaximum =
      session.expected_bytes === this.limitFor(session.purpose);
    if (
      inspected.bytes <= 0 ||
      inspected.bytes > this.limitFor(session.purpose) ||
      (!expectedIsLegacyMaximum && inspected.bytes !== session.expected_bytes)
    ) {
      await this.failSession(session.id, session.object_key);
      throw new BadRequestException({
        code: 'UPLOAD_SIZE_MISMATCH',
        message: 'El tamaño subido no coincide con la sesión',
      });
    }
    if (this.normalizeMime(inspected.mimeType) !== session.mime_type) {
      await this.failSession(session.id, session.object_key);
      throw new BadRequestException({
        code: 'UPLOAD_MIME_MISMATCH',
        message: 'El MIME subido no coincide con la sesión',
      });
    }
    if (!this.hasValidSignature(session.mime_type, inspected.header)) {
      await this.failSession(session.id, session.object_key);
      throw new BadRequestException({
        code: 'UPLOAD_SIGNATURE_INVALID',
        message: 'La firma real del archivo no coincide con su MIME',
      });
    }

    await this.prisma.managedUpload.updateMany({
      where: { id: session.id, status: ManagedUploadStatus.PENDING },
      data: {
        status: ManagedUploadStatus.VERIFIED,
        actual_bytes: inspected.bytes,
        verified_at: new Date(),
      },
    });
    const verified = await this.prisma.managedUpload.findUniqueOrThrow({
      where: { id: session.id },
    });
    return this.serializeSession(verified);
  }

  async prepareForConsumption(options: {
    ownerId: string;
    uploadId?: string | null;
    legacyUrl?: string | null;
    purposes: ManagedUploadPurpose[];
    approvalRequestId?: string;
  }) {
    let session = options.uploadId
      ? await this.prisma.managedUpload.findFirst({
          where: { id: options.uploadId, owner_id: options.ownerId },
        })
      : null;
    if (!session && options.legacyUrl) {
      const objectKey = this.extractManagedFileKey(options.legacyUrl);
      if (objectKey) {
        session = await this.prisma.managedUpload.findFirst({
          where: { object_key: objectKey, owner_id: options.ownerId },
        });
      }
    }
    if (!session) {
      throw new BadRequestException({
        code: 'MANAGED_UPLOAD_REQUIRED',
        message: 'El archivo debe proceder de una sesión de subida gestionada',
      });
    }
    if (!options.purposes.includes(session.purpose)) {
      throw new ForbiddenException(
        'La subida no corresponde al propósito esperado',
      );
    }
    if (session.status === ManagedUploadStatus.PENDING) {
      await this.completeSession(options.ownerId, session.id);
      session = await this.prisma.managedUpload.findUniqueOrThrow({
        where: { id: session.id },
      });
    }
    const reservedForThisApproval =
      session.status === ManagedUploadStatus.RESERVED &&
      Boolean(options.approvalRequestId) &&
      session.approval_request_id === options.approvalRequestId;
    if (
      session.status !== ManagedUploadStatus.VERIFIED &&
      !reservedForThisApproval
    ) {
      throw new ConflictException({
        code: 'UPLOAD_NOT_VERIFIED',
        message: 'La subida aún no está verificada o ya fue consumida',
      });
    }
    return {
      id: session.id,
      purpose: session.purpose,
      file_url: this.buildStoredFileUrl(session.object_key),
      mime_type: session.mime_type,
      bytes: session.actual_bytes ?? session.expected_bytes,
    };
  }

  async consumePrepared(
    db: TransactionClient,
    ownerId: string,
    uploadId: string,
    purposes: ManagedUploadPurpose[],
    approvalRequestId?: string,
  ): Promise<void> {
    const result = await db.managedUpload.updateMany({
      where: {
        id: uploadId,
        owner_id: ownerId,
        purpose: { in: purposes },
        OR: [
          {
            status: ManagedUploadStatus.VERIFIED,
            expires_at: { gt: new Date() },
          },
          ...(approvalRequestId
            ? [{
                status: ManagedUploadStatus.RESERVED,
                approval_request_id: approvalRequestId,
              }]
            : []),
        ],
      },
      data: {
        status: ManagedUploadStatus.CONSUMED,
        consumed_at: new Date(),
        approval_request_id: null,
      },
    });
    if (result.count !== 1) {
      throw new ConflictException({
        code: 'UPLOAD_ALREADY_CONSUMED',
        message: 'La subida ya fue consumida o ha caducado',
      });
    }
  }

  async reserveForApproval(
    db: TransactionClient,
    ownerId: string,
    approvalRequestId: string,
    uploadIds: string[],
  ): Promise<void> {
    for (const uploadId of [...new Set(uploadIds)]) {
      const result = await db.managedUpload.updateMany({
        where: {
          id: uploadId,
          owner_id: ownerId,
          status: ManagedUploadStatus.VERIFIED,
          expires_at: { gt: new Date() },
        },
        data: {
          status: ManagedUploadStatus.RESERVED,
          approval_request_id: approvalRequestId,
        },
      });
      if (result.count !== 1) {
        throw new ConflictException({
          code: 'UPLOAD_NOT_RESERVABLE',
          message: 'Una subida ya fue consumida, caducó o pertenece a otro usuario',
        });
      }
    }
  }

  releaseApprovalUploads(approvalRequestId: string): Promise<unknown> {
    return this.prisma.managedUpload.updateMany({
      where: {
        approval_request_id: approvalRequestId,
        status: ManagedUploadStatus.RESERVED,
      },
      data: {
        status: ManagedUploadStatus.VERIFIED,
        approval_request_id: null,
        expires_at: new Date(Date.now() + SESSION_TTL_MS),
      },
    });
  }

  referencesSame(
    left: string | null | undefined,
    right: string | null | undefined,
  ): boolean {
    if (left === right) return true;
    if (!left || !right) return false;
    const leftKey = this.extractManagedFileKey(left);
    const rightKey = this.extractManagedFileKey(right);
    return Boolean(leftKey && rightKey && leftKey === rightKey);
  }

  async getLegacyPresignedUrl(
    ownerId: string,
    role: string,
    fileKey: string,
    contentType: string,
    bytes?: number,
  ) {
    return this.createSession(ownerId, role, {
      purpose: this.inferLegacyPurpose(role, fileKey, contentType),
      mimeType: contentType,
      bytes,
    });
  }

  async isConsumedManagedUrl(
    ownerId: string,
    fileUrl: string | null | undefined,
    purposes: ManagedUploadPurpose[],
  ): Promise<boolean> {
    if (!fileUrl) return false;
    const objectKey = this.extractManagedFileKey(fileUrl);
    if (!objectKey) return false;
    const session = await this.prisma.managedUpload.findFirst({
      where: {
        owner_id: ownerId,
        object_key: objectKey,
        purpose: { in: purposes },
        status: ManagedUploadStatus.CONSUMED,
      },
      select: { id: true },
    });
    return Boolean(session);
  }

  async uploadLegacyFile(
    ownerId: string,
    role: string,
    buffer: Buffer,
    fileKey: string,
    contentType: string,
  ) {
    const session = await this.createSession(ownerId, role, {
      purpose: this.inferLegacyPurpose(role, fileKey, contentType),
      mimeType: contentType,
      bytes: buffer.length,
    });
    const managed = await this.prisma.managedUpload.findUniqueOrThrow({
      where: { id: session.upload_id },
    });
    await this.uploadFile(buffer, managed.object_key, managed.mime_type);
    return this.completeSession(ownerId, managed.id);
  }

  async uploadLegacyFileFromPath(
    ownerId: string,
    role: string,
    filePath: string,
    bytes: number,
    fileKey: string,
    contentType: string,
  ) {
    const session = await this.createSession(ownerId, role, {
      purpose: this.inferLegacyPurpose(role, fileKey, contentType),
      mimeType: contentType,
      bytes,
    });
    const managed = await this.prisma.managedUpload.findUniqueOrThrow({
      where: { id: session.upload_id },
    });
    try {
      await this.uploadFileFromPath(
        filePath,
        bytes,
        managed.object_key,
        managed.mime_type,
      );
      return await this.completeSession(ownerId, managed.id);
    } catch (error) {
      await this.failSession(managed.id, managed.object_key);
      throw error;
    }
  }

  async getSignedReadUrl(
    fileUrl: string | null | undefined,
    expiresIn = this.signedReadExpiresIn,
  ): Promise<string | null> {
    if (!fileUrl) return null;
    if (this.isDev || fileUrl.includes('X-Amz-Signature=')) return fileUrl;
    const fileKey = this.extractManagedFileKey(fileUrl);
    if (!fileKey) return fileUrl;
    return getSignedUrl(
      this.s3Client,
      new GetObjectCommand({ Bucket: this.bucket, Key: fileKey }),
      { expiresIn },
    );
  }

  async uploadFile(
    buffer: Buffer,
    fileKey: string,
    contentType: string,
  ): Promise<{ file_url: string; signed_read_url?: string | null }> {
    if (this.isDev) return this.uploadFileLocal(buffer, fileKey);
    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: fileKey,
        Body: buffer,
        ContentType: contentType,
      }),
    );
    const file_url = this.buildStoredFileUrl(fileKey);
    return {
      file_url,
      signed_read_url: await this.getSignedReadUrl(file_url),
    };
  }

  async deleteFileByUrl(fileUrl: string): Promise<boolean> {
    const fileKey = this.extractManagedFileKey(fileUrl);
    if (!fileKey) return false;
    await this.deleteManagedObject(fileKey);
    return true;
  }

  private async deleteManagedObject(fileKey: string): Promise<void> {
    if (this.isDev) {
      this.deleteFileLocal(fileKey);
      return;
    }
    await this.s3Client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: fileKey }),
    );
  }

  @Cron('0 */30 * * * *')
  async purgeExpiredSessions(): Promise<number> {
    const expired = await this.prisma.managedUpload.findMany({
      where: {
        OR: [
          { status: ManagedUploadStatus.FAILED },
          {
            status: {
              in: [ManagedUploadStatus.PENDING, ManagedUploadStatus.VERIFIED],
            },
            expires_at: { lte: new Date() },
          },
        ],
      },
      take: 100,
    });
    for (const session of expired) {
      try {
        await this.deleteManagedObject(session.object_key);
      } catch {
        // Keep FAILED/PENDING/VERIFIED visible so the next cron can retry.
        continue;
      }
      await this.prisma.managedUpload.updateMany({
        where: {
          id: session.id,
          status: {
            in: [
              ManagedUploadStatus.PENDING,
              ManagedUploadStatus.VERIFIED,
              ManagedUploadStatus.FAILED,
            ],
          },
        },
        data: { status: ManagedUploadStatus.EXPIRED },
      });
    }
    return expired.length;
  }

  private serializeSession(session: {
    id: string;
    object_key: string;
    status: ManagedUploadStatus;
    expires_at: Date;
    actual_bytes: number | null;
    mime_type: string;
  }) {
    return {
      upload_id: session.id,
      status: session.status,
      file_url: this.buildStoredFileUrl(session.object_key),
      signed_read_url: null,
      expires_at: session.expires_at,
      bytes: session.actual_bytes,
      content_type: session.mime_type,
    };
  }

  private async failSession(id: string, objectKey?: string) {
    await this.prisma.managedUpload.updateMany({
      where: {
        id,
        status: { in: [ManagedUploadStatus.PENDING, ManagedUploadStatus.VERIFIED] },
      },
      data: { status: ManagedUploadStatus.FAILED },
    });
    if (objectKey) {
      await this.deleteManagedObject(objectKey).catch(() => undefined);
    }
  }

  private async inspectObject(
    objectKey: string,
  ): Promise<{ bytes: number; mimeType: string; header: Buffer }> {
    if (this.isDev) {
      const filePath = this.localFilePath(objectKey);
      if (!fs.existsSync(filePath)) {
        throw new BadRequestException('No se encontró el archivo subido');
      }
      const stat = fs.statSync(filePath);
      const fd = fs.openSync(filePath, 'r');
      try {
        const header = Buffer.alloc(Math.min(32, stat.size));
        fs.readSync(fd, header, 0, header.length, 0);
        const record = await this.prisma.managedUpload.findUniqueOrThrow({
          where: { object_key: objectKey },
        });
        return { bytes: stat.size, mimeType: record.mime_type, header };
      } finally {
        fs.closeSync(fd);
      }
    }
    const head = await this.s3Client.send(
      new HeadObjectCommand({ Bucket: this.bucket, Key: objectKey }),
    );
    const object = await this.s3Client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
        Range: 'bytes=0-31',
      }),
    );
    const header = object.Body
      ? Buffer.from(await object.Body.transformToByteArray())
      : Buffer.alloc(0);
    return {
      bytes: Number(head.ContentLength ?? 0),
      mimeType: head.ContentType ?? '',
      header,
    };
  }

  private hasValidSignature(mimeType: string, bytes: Buffer): boolean {
    if (mimeType === 'image/jpeg') {
      return (
        bytes.length >= 3 &&
        bytes[0] === 0xff &&
        bytes[1] === 0xd8 &&
        bytes[2] === 0xff
      );
    }
    if (mimeType === 'image/png') {
      return (
        bytes.length >= 8 &&
        bytes
          .subarray(0, 8)
          .equals(
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          )
      );
    }
    if (mimeType === 'image/webp') {
      return (
        bytes.length >= 12 &&
        bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
        bytes.subarray(8, 12).toString('ascii') === 'WEBP'
      );
    }
    if (mimeType === 'video/webm') {
      return (
        bytes.length >= 4 &&
        bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
      );
    }
    if (VIDEO_MIME_TYPES.has(mimeType)) {
      return (
        bytes.length >= 12 &&
        bytes.subarray(4, 8).toString('ascii') === 'ftyp'
      );
    }
    return false;
  }

  private assertPurposeAllowed(role: string, purpose: ManagedUploadPurpose) {
    const clientPurposes = [
      ManagedUploadPurpose.AVATAR,
      ManagedUploadPurpose.FEEDBACK_IMAGE,
      ManagedUploadPurpose.FEEDBACK_VIDEO,
    ];
    const adminPurposes = [
      ManagedUploadPurpose.AVATAR,
      ManagedUploadPurpose.EXERCISE_VIDEO,
      ManagedUploadPurpose.EXERCISE_THUMBNAIL,
      ManagedUploadPurpose.MEAL_IMAGE,
    ];
    const allowed: ManagedUploadPurpose[] =
      role === Role.CLIENT
        ? clientPurposes
        : role === Role.ADMIN || role === Role.SUPER_ADMIN
          ? adminPurposes
          : [];
    if (!allowed.includes(purpose)) {
      throw new ForbiddenException(
        'No puedes crear una subida con ese propósito',
      );
    }
  }

  private inferLegacyPurpose(
    role: string,
    fileKey: string,
    contentType: string,
  ): ManagedUploadPurpose {
    const key = fileKey.toLowerCase();
    const mime = this.normalizeMime(contentType);
    if (key.includes('avatar') || key.includes('profile')) {
      return ManagedUploadPurpose.AVATAR;
    }
    if (role === Role.CLIENT) {
      return VIDEO_MIME_TYPES.has(mime)
        ? ManagedUploadPurpose.FEEDBACK_VIDEO
        : ManagedUploadPurpose.FEEDBACK_IMAGE;
    }
    if (VIDEO_MIME_TYPES.has(mime)) {
      return ManagedUploadPurpose.EXERCISE_VIDEO;
    }
    if (
      key.includes('meal') ||
      key.includes('diet') ||
      key.includes('food')
    ) {
      return ManagedUploadPurpose.MEAL_IMAGE;
    }
    return ManagedUploadPurpose.EXERCISE_THUMBNAIL;
  }

  private assertMimeAllowed(
    purpose: ManagedUploadPurpose,
    mimeType: string,
  ) {
    const valid =
      purpose === ManagedUploadPurpose.FEEDBACK_VIDEO ||
      purpose === ManagedUploadPurpose.EXERCISE_VIDEO
        ? VIDEO_MIME_TYPES.has(mimeType)
        : IMAGE_MIME_TYPES.has(mimeType);
    if (!valid) {
      throw new BadRequestException({
        code: 'UPLOAD_MIME_NOT_ALLOWED',
        message: 'MIME no permitido para este propósito',
      });
    }
  }

  private normalizeMime(value: string) {
    return value.split(';', 1)[0].trim().toLowerCase();
  }

  private limitFor(purpose: ManagedUploadPurpose) {
    if (purpose === ManagedUploadPurpose.EXERCISE_VIDEO) {
      return EXERCISE_VIDEO_LIMIT;
    }
    if (purpose === ManagedUploadPurpose.FEEDBACK_VIDEO) {
      return FEEDBACK_VIDEO_LIMIT;
    }
    return IMAGE_LIMIT;
  }

  private prefixFor(purpose: ManagedUploadPurpose) {
    return purpose.toLowerCase().replaceAll('_', '-');
  }

  private extensionFor(mime: string) {
    return (
      {
        'image/jpeg': '.jpg',
        'image/png': '.png',
        'image/webp': '.webp',
        'video/mp4': '.mp4',
        'video/quicktime': '.mov',
        'video/x-m4v': '.m4v',
        'video/webm': '.webm',
      } as Record<string, string>
    )[mime] ?? '';
  }

  private buildStoredFileUrl(fileKey: string): string {
    if (!this.publicUrl) return `r2://${fileKey}`;
    return `${this.publicUrl.replace(/\/$/, '')}/${fileKey}`;
  }

  private extractManagedFileKey(fileUrl: string): string | null {
    const raw = fileUrl.trim();
    if (raw.startsWith('r2://')) {
      return this.normalizeObjectKey(raw.slice('r2://'.length).split(/[?#]/, 1)[0]);
    }

    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return null;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;

    const publicBase = this.parseConfiguredUrl(this.publicUrl);
    if (publicBase && parsed.origin === publicBase.origin) {
      const prefix = publicBase.pathname.replace(/\/$/, '');
      if (parsed.pathname.startsWith(`${prefix}/`)) {
        return this.decodeObjectKey(parsed.pathname.slice(prefix.length + 1));
      }
    }

    const endpoint = this.parseConfiguredUrl(this.endpoint);
    if (endpoint) {
      const pathStylePrefix = `${endpoint.pathname.replace(/\/$/, '')}/${this.bucket}/`;
      const virtualHost = `${this.bucket}.${endpoint.hostname}`;
      if (parsed.origin === endpoint.origin && parsed.pathname.startsWith(pathStylePrefix)) {
        return this.decodeObjectKey(parsed.pathname.slice(pathStylePrefix.length));
      }
      if (
        parsed.protocol === endpoint.protocol &&
        parsed.hostname === virtualHost &&
        parsed.port === endpoint.port
      ) {
        return this.decodeObjectKey(parsed.pathname.slice(1));
      }
    }

    const port = String(this.config.get<number>('PORT', 3000));
    if (
      this.isDev &&
      ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname) &&
      (!parsed.port || parsed.port === port)
    ) {
      const marker = '/api/v1/uploads/local/';
      if (parsed.pathname.startsWith(marker)) {
        return this.decodeObjectKey(parsed.pathname.slice(marker.length));
      }
    }
    return null;
  }

  private parseConfiguredUrl(value: string): URL | null {
    if (!value) return null;
    try {
      return new URL(value);
    } catch {
      return null;
    }
  }

  private normalizeObjectKey(value: string): string | null {
    const key = value.replace(/^\/+/, '');
    if (!key || key.includes('\\') || key.split('/').includes('..')) return null;
    return key;
  }

  private decodeObjectKey(value: string): string | null {
    try {
      return this.normalizeObjectKey(decodeURIComponent(value));
    } catch {
      return null;
    }
  }

  private async uploadFileLocal(
    buffer: Buffer,
    fileKey: string,
  ): Promise<{ file_url: string }> {
    const filePath = this.localFilePath(fileKey);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, buffer);
    const port = this.config.get<number>('PORT', 3000);
    return {
      file_url: `http://localhost:${port}/api/v1/uploads/local/${fileKey}`,
    };
  }

  private async uploadFileFromPath(
    sourcePath: string,
    bytes: number,
    fileKey: string,
    contentType: string,
  ): Promise<void> {
    if (this.isDev) {
      const targetPath = this.localFilePath(fileKey);
      await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.promises.copyFile(sourcePath, targetPath);
      return;
    }
    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: fileKey,
        Body: fs.createReadStream(sourcePath),
        ContentLength: bytes,
        ContentType: contentType,
      }),
    );
  }

  private localFilePath(fileKey: string): string {
    const normalized = this.normalizeObjectKey(fileKey);
    if (!normalized) throw new BadRequestException('Clave de archivo no válida');
    const base = path.resolve(this.localUploadsDir);
    const target = path.resolve(base, normalized);
    if (target !== base && !target.startsWith(`${base}${path.sep}`)) {
      throw new BadRequestException('Clave de archivo no válida');
    }
    return target;
  }

  private deleteFileLocal(fileKey: string): boolean {
    const filePath = this.localFilePath(fileKey);
    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);
    return true;
  }
}
