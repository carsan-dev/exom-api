import { S3Client } from '@aws-sdk/client-s3';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BASE_ENV } from './base-service.constants';
import { BasePdfSource, LocalDirBasePdfSource } from './base-pdf-source';
import { R2BasePdfSource } from './base-pdf-source-r2';

export type BaseSourceUnavailableReason =
  | 'NOT_CONFIGURED'
  | 'R2_CREDENTIALS_MISSING'
  | 'MEDIA_BUCKET_REJECTED';

/** The feature has no usable source; never answered by falling back. */
export class BaseSourceNotConfiguredError extends Error {
  constructor(readonly reason: BaseSourceUnavailableReason) {
    super(reason);
    this.name = 'BaseSourceNotConfiguredError';
  }
}

export type BasePdfSourceResolution =
  | { kind: 'r2' | 'local'; source: BasePdfSource }
  | { kind: 'unconfigured'; reason: BaseSourceUnavailableReason };

type Env = (name: string) => string | undefined;

function value(env: Env, name: string): string | undefined {
  const raw = env(name)?.trim();
  return raw ? raw : undefined;
}

/**
 * Picks the source of the base-service PDFs:
 * 1. `R2_BASE_PDF_BUCKET` set: that private bucket, with the existing R2
 *    account credentials. If anything is missing, or the name is the public
 *    media bucket, the feature is unconfigured: it never falls back.
 * 2. Otherwise, outside production, `BASE_PDF_LOCAL_DIR` (dev/test).
 * 3. Otherwise unconfigured.
 */
export function resolveBasePdfSource(
  env: Env,
  createClient: (endpoint: string, key: string, secret: string) => S3Client = (
    endpoint,
    key,
    secret,
  ) =>
    // Same account, endpoint and timeouts as UploadsService; reads only.
    new S3Client({
      maxAttempts: 2,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      requestHandler: { requestTimeout: 15000, connectionTimeout: 5000 },
      region: 'auto',
      endpoint,
      credentials: { accessKeyId: key, secretAccessKey: secret },
    }),
): BasePdfSourceResolution {
  const bucket = value(env, BASE_ENV.BUCKET);
  if (bucket) {
    const mediaBuckets = [value(env, 'R2_BUCKET_NAME'), 'exom-media'];
    if (mediaBuckets.includes(bucket))
      return { kind: 'unconfigured', reason: 'MEDIA_BUCKET_REJECTED' };
    const endpoint = value(env, 'R2_ENDPOINT');
    const key = value(env, 'R2_ACCESS_KEY_ID');
    const secret = value(env, 'R2_SECRET_ACCESS_KEY');
    if (!endpoint || !key || !secret)
      return { kind: 'unconfigured', reason: 'R2_CREDENTIALS_MISSING' };
    return {
      kind: 'r2',
      source: new R2BasePdfSource(createClient(endpoint, key, secret), bucket),
    };
  }
  const localDir = value(env, BASE_ENV.LOCAL_DIR);
  if (localDir && value(env, 'NODE_ENV') !== 'production')
    return { kind: 'local', source: new LocalDirBasePdfSource(localDir) };
  return { kind: 'unconfigured', reason: 'NOT_CONFIGURED' };
}

@Injectable()
export class BasePdfSourceProvider {
  private readonly resolution: BasePdfSourceResolution;

  constructor(config: ConfigService) {
    this.resolution = resolveBasePdfSource((name) => config.get<string>(name));
  }

  get kind(): BasePdfSourceResolution['kind'] {
    return this.resolution.kind;
  }

  /** The configured source, or {@link BaseSourceNotConfiguredError}. */
  source(): BasePdfSource {
    if (this.resolution.kind === 'unconfigured')
      throw new BaseSourceNotConfiguredError(this.resolution.reason);
    return this.resolution.source;
  }
}
