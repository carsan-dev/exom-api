import { Injectable } from '@nestjs/common';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class UploadsService {
  private readonly s3Client: S3Client;
  private readonly bucket: string;
  private readonly publicUrl: string;
  private readonly isDev: boolean;
  private readonly localUploadsDir: string;
  private readonly signedReadExpiresIn: number;

  constructor(private readonly config: ConfigService) {
    this.bucket = this.config.get<string>('R2_BUCKET_NAME', '');
    this.publicUrl = this.config.get<string>('R2_PUBLIC_URL', '');
    this.isDev = this.config.get<string>('NODE_ENV') !== 'production';
    this.localUploadsDir = path.join(process.cwd(), 'uploads');
    this.signedReadExpiresIn = parseInt(
      this.config.get<string>('R2_SIGNED_READ_EXPIRES_SECONDS', '21600'),
      10,
    );

    this.s3Client = new S3Client({
      region: 'auto',
      endpoint: this.config.get<string>('R2_ENDPOINT'),
      credentials: {
        accessKeyId: this.config.get<string>('R2_ACCESS_KEY_ID', ''),
        secretAccessKey: this.config.get<string>('R2_SECRET_ACCESS_KEY', ''),
      },
    });
  }

  async getPresignedUrl(
    fileKey: string,
    contentType: string,
    expiresIn: number = 900,
  ) {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: fileKey,
      ContentType: contentType,
    });

    const upload_url = await getSignedUrl(this.s3Client, command, {
      expiresIn,
    });

    const file_url = this.buildStoredFileUrl(fileKey);
    return {
      upload_url,
      file_url,
      signed_read_url: await this.getSignedReadUrl(file_url),
      expires_at: new Date(Date.now() + expiresIn * 1000),
    };
  }

  async getSignedReadUrl(
    fileUrl: string | null | undefined,
    expiresIn: number = this.signedReadExpiresIn,
  ): Promise<string | null> {
    if (!fileUrl) {
      return null;
    }

    if (this.isDev || fileUrl.includes('X-Amz-Signature=')) {
      return fileUrl;
    }

    const fileKey = this.extractManagedFileKey(fileUrl);
    if (!fileKey) {
      return fileUrl;
    }

    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: fileKey,
    });

    return getSignedUrl(this.s3Client, command, { expiresIn });
  }

  async uploadFile(
    buffer: Buffer,
    fileKey: string,
    contentType: string,
  ): Promise<{ file_url: string; signed_read_url?: string | null }> {
    if (this.isDev) {
      return this.uploadFileLocal(buffer, fileKey);
    }

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: fileKey,
      Body: buffer,
      ContentType: contentType,
    });

    await this.s3Client.send(command);

    const file_url = this.buildStoredFileUrl(fileKey);
    return {
      file_url,
      signed_read_url: await this.getSignedReadUrl(file_url),
    };
  }

  async deleteFileByUrl(fileUrl: string): Promise<boolean> {
    const fileKey = this.extractFileKeyFromUrl(fileUrl);

    if (!fileKey) {
      return false;
    }

    if (this.isDev) {
      return this.deleteFileLocal(fileKey);
    }

    const command = new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: fileKey,
    });

    await this.s3Client.send(command);
    return true;
  }

  private async uploadFileLocal(
    buffer: Buffer,
    fileKey: string,
  ): Promise<{ file_url: string }> {
    const filePath = path.join(this.localUploadsDir, fileKey);
    const dir = path.dirname(filePath);

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, buffer);

    const port = this.config.get<number>('PORT', 3000);
    return { file_url: `http://localhost:${port}/api/v1/uploads/local/${fileKey}` };
  }

  private deleteFileLocal(fileKey: string): boolean {
    const filePath = path.join(this.localUploadsDir, fileKey);

    if (!fs.existsSync(filePath)) {
      return false;
    }

    fs.unlinkSync(filePath);
    return true;
  }

  private buildStoredFileUrl(fileKey: string): string {
    if (!this.publicUrl) {
      return `r2://${fileKey}`;
    }

    return `${this.publicUrl}/${fileKey}`;
  }

  private extractManagedFileKey(fileUrl: string): string | null {
    if (fileUrl.startsWith('r2://')) {
      return fileUrl.slice('r2://'.length);
    }

    if (this.publicUrl && fileUrl.startsWith(`${this.publicUrl}/`)) {
      return fileUrl.slice(this.publicUrl.length + 1);
    }

    const localMarker = '/uploads/local/';
    const markerIndex = fileUrl.indexOf(localMarker);
    if (markerIndex >= 0) {
      return fileUrl.slice(markerIndex + localMarker.length);
    }

    return null;
  }

  private extractFileKeyFromUrl(fileUrl: string): string | null {
    if (!fileUrl) {
      return null;
    }

    if (fileUrl.startsWith('r2://')) {
      return fileUrl.slice('r2://'.length);
    }

    if (this.publicUrl && fileUrl.startsWith(`${this.publicUrl}/`)) {
      return fileUrl.slice(this.publicUrl.length + 1);
    }

    const localMarker = '/uploads/local/';
    const markerIndex = fileUrl.indexOf(localMarker);
    if (markerIndex >= 0) {
      return fileUrl.slice(markerIndex + localMarker.length);
    }

    try {
      const parsed = new URL(fileUrl);
      const normalizedPath = parsed.pathname.replace(/^\/+/, '');
      return normalizedPath || null;
    } catch {
      return null;
    }
  }
}
