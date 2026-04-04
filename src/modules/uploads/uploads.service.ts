import { Injectable } from '@nestjs/common';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
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

  constructor(private readonly config: ConfigService) {
    this.bucket = this.config.get<string>('R2_BUCKET_NAME', '');
    this.publicUrl = this.config.get<string>('R2_PUBLIC_URL', '');
    this.isDev = this.config.get<string>('NODE_ENV') !== 'production';
    this.localUploadsDir = path.join(process.cwd(), 'uploads');

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

    return {
      upload_url,
      file_url: `${this.publicUrl}/${fileKey}`,
      expires_at: new Date(Date.now() + expiresIn * 1000),
    };
  }

  async uploadFile(
    buffer: Buffer,
    fileKey: string,
    contentType: string,
  ): Promise<{ file_url: string }> {
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

    return { file_url: `${this.publicUrl}/${fileKey}` };
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
}
