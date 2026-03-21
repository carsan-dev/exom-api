import { S3Client } from '@aws-sdk/client-s3';

let r2Client: S3Client | null = null;

export function getR2Client(): S3Client {
  if (r2Client) return r2Client;

  r2Client = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? '',
    },
  });

  return r2Client;
}

export const R2_BUCKET = () => process.env.R2_BUCKET_NAME ?? 'exom-media';
export const R2_PUBLIC_URL = () => process.env.R2_PUBLIC_URL ?? 'https://media.exom.app';
