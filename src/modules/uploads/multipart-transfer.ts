import {
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListPartsCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { UploadTransfer } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { Readable } from 'node:stream';

/** User lock (when alive), then transfer advisory lock, then receipt updates.
 * Intent writes use a separate committed transaction BEFORE the remote effect.
 * A process/connection loss therefore never rolls back recovery metadata.
 */
export class MultipartTransfer {
  constructor(
    private readonly db: PrismaService,
    private readonly s3: S3Client,
    private readonly bucket: string,
  ) {}

  private locked<T>(id: string, action: () => Promise<T>): Promise<T> {
    return this.db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`upload-transfer:${id}`}, 0))::text`;
        return action();
      },
      { timeout: 120000 },
    );
  }

  private parameters(row: UploadTransfer) {
    if (!row.object_key) throw this.pending();
    return {
      Bucket: this.bucket,
      Key: row.object_key,
      UploadId: row.multipart_id ?? undefined,
    };
  }

  private pending() {
    return new ServiceUnavailableException({
      code: 'UPLOAD_TRANSFER_PENDING',
      message: 'La transferencia está pendiente de recuperación',
    });
  }

  private async inventory(row: UploadTransfer): Promise<string[]> {
    const result = await this.s3.send(
      new ListMultipartUploadsCommand({
        Bucket: this.bucket,
        Prefix: this.parameters(row).Key,
        MaxUploads: 100,
      }),
    );
    if (
      result.IsTruncated ||
      result.Uploads?.some((u) => u.Key !== row.object_key)
    )
      throw this.pending();
    return (result.Uploads ?? []).map((u) => {
      if (!u.UploadId) throw this.pending();
      return u.UploadId;
    });
  }

  private async open(id: string, mime: string): Promise<UploadTransfer> {
    let row = await this.db.uploadTransfer.findUniqueOrThrow({ where: { id } });
    if (
      row.protocol !== 'MULTIPART' ||
      row.cancel_requested ||
      ['CANCELLED', 'PUBLISHED', 'COMPLETING'].includes(row.state)
    ) {
      throw new ConflictException({
        code: 'UPLOAD_EXPIRED',
        message: 'La sesión ya no admite transferencias',
      });
    }
    if (row.state === 'NEW') {
      const claimed = await this.db.uploadTransfer.updateMany({
        where: { id, state: 'NEW', cancel_requested: false },
        data: { state: 'CREATING', external_pending: 'CREATE' },
      });
      if (!claimed.count) throw this.pending();
      // Never repeat CREATE after a lost response. Recover by the exact unique key.
      const created = await this.s3.send(
        new CreateMultipartUploadCommand({
          Bucket: this.bucket,
          Key: this.parameters(row).Key,
          ContentType: mime,
        }),
      );
      if (!created.UploadId) throw this.pending();
      await this.db.uploadTransfer.updateMany({
        where: { id, state: 'CREATING', cancel_requested: false },
        data: {
          state: 'UPLOADING',
          multipart_id: created.UploadId,
          external_pending: null,
        },
      });
    } else if (row.state === 'CREATING') {
      const ids = await this.inventory(row);
      if (ids.length !== 1) throw this.pending();
      await this.db.uploadTransfer.updateMany({
        where: { id, state: 'CREATING', cancel_requested: false },
        data: {
          state: 'UPLOADING',
          multipart_id: ids[0],
          external_pending: null,
        },
      });
    }
    row = await this.db.uploadTransfer.findUniqueOrThrow({ where: { id } });
    if (row.state !== 'UPLOADING' || row.cancel_requested || !row.multipart_id)
      throw this.pending();
    return row;
  }

  signedPart(id: string, mime: string, ttl: number): Promise<string> {
    return this.locked(id, async () => {
      const row = await this.open(id, mime);
      return getSignedUrl(
        this.s3,
        new UploadPartCommand({ ...this.parameters(row), PartNumber: 1 }),
        { expiresIn: ttl },
      );
    });
  }

  put(
    id: string,
    mime: string,
    body: Buffer | Readable,
    bytes: number,
  ): Promise<void> {
    return this.locked(id, async () => {
      const row = await this.open(id, mime);
      // UploadPart cannot publish. The multipart ID remains durable on any error.
      await this.s3.send(
        new UploadPartCommand({
          ...this.parameters(row),
          PartNumber: 1,
          Body: body,
          ContentLength: bytes,
        }),
      );
    });
  }

  publish(id: string): Promise<void> {
    return this.locked(id, async () => {
      let row = await this.db.uploadTransfer.findUnique({ where: { id } });
      // Historical direct objects remain inspectable, but cannot gain new PUT URLs.
      if (!row || row.protocol !== 'MULTIPART') return;
      if (row.cancel_requested || row.state === 'CANCELLED')
        throw this.pending();
      if (row.state === 'PUBLISHED') return;
      if (!row.multipart_id) throw this.pending();
      if (row.state === 'COMPLETING') {
        try {
          await this.s3.send(
            new HeadObjectCommand({
              Bucket: this.bucket,
              Key: this.parameters(row).Key,
            }),
          );
          await this.db.uploadTransfer.updateMany({
            where: { id, state: 'COMPLETING', cancel_requested: false },
            data: { state: 'PUBLISHED', external_pending: null },
          });
          return;
        } catch (error) {
          if (!this.isMissing(error)) throw error;
        }
      } else {
        const parts = await this.s3.send(
          new ListPartsCommand(this.parameters(row)),
        );
        if (!parts.Parts?.length)
          throw new NotFoundException({
            code: 'UPLOAD_OBJECT_MISSING',
            message: 'La transferencia aún no está confirmada',
          });
        if (
          parts.IsTruncated ||
          parts.Parts.length !== 1 ||
          parts.Parts[0].PartNumber !== 1 ||
          !parts.Parts[0].ETag
        )
          throw this.pending();
        const claimed = await this.db.uploadTransfer.updateMany({
          where: { id, state: 'UPLOADING', cancel_requested: false },
          data: {
            state: 'COMPLETING',
            external_pending: 'COMPLETE',
            etag: parts.Parts[0].ETag,
          },
        });
        if (!claimed.count) throw this.pending();
        row = await this.db.uploadTransfer.findUniqueOrThrow({ where: { id } });
      }
      if (!row.etag) throw this.pending();
      await this.s3.send(
        new CompleteMultipartUploadCommand({
          ...this.parameters(row),
          MultipartUpload: { Parts: [{ PartNumber: 1, ETag: row.etag }] },
        }),
      );
      await this.db.uploadTransfer.updateMany({
        where: { id, state: 'COMPLETING', cancel_requested: false },
        data: { state: 'PUBLISHED', external_pending: null },
      });
    });
  }

  cancel(id: string): Promise<boolean> {
    return this.locked(id, async () => {
      let row = await this.db.uploadTransfer.findUniqueOrThrow({
        where: { id },
      });
      if (row.protocol === 'DIRECT') return false;
      if (row.state === 'CANCELLED') return true;
      row = await this.db.uploadTransfer.update({
        where: { id },
        data: { cancel_requested: true },
      });
      if (row.protocol === 'MULTIPART' && row.state !== 'NEW') {
        const ids = new Set([
          ...row.recovery_ids,
          ...(await this.inventory(row)),
        ]);
        if (row.multipart_id) ids.add(row.multipart_id);
        // No response and no listed upload is UNCERTAIN, never proof of no CREATE.
        if (!ids.size) return false;
        await this.db.uploadTransfer.update({
          where: { id },
          data: { external_pending: 'ABORT', recovery_ids: [...ids] },
        });
        for (const uploadId of ids) {
          const parameters = { ...this.parameters(row), UploadId: uploadId };
          try {
            await this.s3.send(new AbortMultipartUploadCommand(parameters));
          } catch (error) {
            if (!this.isNoSuchUpload(error)) throw error;
          }
          try {
            await this.s3.send(new ListPartsCommand(parameters));
            return false;
          } catch (error) {
            if (!this.isNoSuchUpload(error)) throw error;
          }
        }
        if ((await this.inventory(row)).length) return false;
      }
      await this.db.uploadTransfer.update({
        where: { id },
        data: { state: 'CANCELLED', external_pending: null },
      });
      return true;
    });
  }

  async cancelOwner(owner: string): Promise<boolean> {
    const rows = await this.db.uploadTransfer.findMany({
      where: {
        owner_id: owner,
        protocol: { not: 'DIRECT' },
        state: { not: 'CANCELLED' },
      },
      orderBy: [{ updated_at: 'asc' }, { id: 'asc' }],
      take: 100,
    });
    for (const row of rows) await this.cancel(row.id);
    return (
      (await this.db.uploadTransfer.count({
        where: { owner_id: owner, state: { not: 'CANCELLED' } },
      })) === 0
    );
  }

  private isMissing(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      '$metadata' in error &&
      typeof error.$metadata === 'object' &&
      error.$metadata !== null &&
      'httpStatusCode' in error.$metadata &&
      error.$metadata.httpStatusCode === 404
    );
  }

  private isNoSuchUpload(error: unknown): boolean {
    return (
      this.isMissing(error) &&
      error instanceof Error &&
      error.name === 'NoSuchUpload'
    );
  }
}
