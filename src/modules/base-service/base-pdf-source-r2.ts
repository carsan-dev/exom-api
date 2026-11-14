import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { assertSafeSourceKey, BasePdfSource } from './base-pdf-source';
import { BaseServiceError } from './base-service.error';

/** Upper bound for the catalogue listing (91 PDFs today). */
const MAX_LISTED_KEYS = 5000;
/** A source PDF is ~1.3 MB; refuse anything absurd before buffering it. */
const MAX_SOURCE_BYTES = 50 * 1024 * 1024;

type S3Like = Pick<S3Client, 'send'>;

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (('name' in error && error.name === 'NoSuchKey') ||
      ('$metadata' in error &&
        typeof error.$metadata === 'object' &&
        error.$metadata !== null &&
        'httpStatusCode' in error.$metadata &&
        error.$metadata.httpStatusCode === 404))
  );
}

/**
 * {@link BasePdfSource} over a DEDICATED PRIVATE S3/R2 bucket. Keys are the
 * catalogue layout at the bucket root (`entrenamiento/...`, `nutricion/...`).
 * Read-only: this class never writes, deletes or presigns anything.
 */
export class R2BasePdfSource implements BasePdfSource {
  constructor(
    private readonly client: S3Like,
    private readonly bucket: string,
  ) {}

  async list(): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          ContinuationToken: token,
          MaxKeys: 1000,
        }),
        { abortSignal: AbortSignal.timeout(15000) },
      );
      for (const item of page.Contents ?? []) {
        // Folder placeholders and anything outside the layout are ignored by
        // selectPackage; only drop the obvious directory markers here.
        if (item.Key && !item.Key.endsWith('/')) keys.push(item.Key);
      }
      if (keys.length > MAX_LISTED_KEYS)
        throw new Error('BASE_SOURCE_INVENTORY_TOO_LARGE');
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
      if (page.IsTruncated && !token)
        throw new Error('BASE_SOURCE_INVENTORY_INCOMPLETE');
    } while (token);
    return keys.sort();
  }

  async get(key: string): Promise<Buffer> {
    assertSafeSourceKey(key);
    try {
      const object = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        { abortSignal: AbortSignal.timeout(30000) },
      );
      if (
        typeof object.ContentLength === 'number' &&
        object.ContentLength > MAX_SOURCE_BYTES
      )
        throw new Error('BASE_SOURCE_TOO_LARGE');
      if (!object.Body) throw new Error('BASE_SOURCE_EMPTY_BODY');
      return Buffer.from(await object.Body.transformToByteArray());
    } catch (error) {
      if (isMissing(error)) {
        throw new BaseServiceError(
          'SOURCE_NOT_FOUND',
          `No existe el archivo de origen «${key}».`,
        );
      }
      throw error;
    }
  }
}
