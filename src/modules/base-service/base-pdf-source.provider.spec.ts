import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { ConfigService } from '@nestjs/config';
import { LocalDirBasePdfSource } from './base-pdf-source';
import { R2BasePdfSource } from './base-pdf-source-r2';
import {
  BasePdfSourceProvider,
  BaseSourceNotConfiguredError,
  resolveBasePdfSource,
} from './base-pdf-source.provider';
import { BaseServiceError } from './base-service.error';

const R2 = {
  R2_ENDPOINT: 'https://account.r2.example.test',
  R2_ACCESS_KEY_ID: 'test-only-key',
  R2_SECRET_ACCESS_KEY: 'test-only-secret',
  R2_BUCKET_NAME: 'exom-media-dev',
};

function envOf(values: Record<string, string>) {
  return (name: string) => values[name];
}

describe('resolveBasePdfSource', () => {
  it('uses the dedicated private bucket with the existing R2 credentials', () => {
    const created: string[][] = [];
    const resolution = resolveBasePdfSource(
      envOf({ ...R2, R2_BASE_PDF_BUCKET: 'exom-base-pdfs' }),
      (endpoint, key, secret) => {
        created.push([endpoint, key, secret]);
        return new S3Client({ region: 'auto' });
      },
    );
    expect(resolution.kind).toBe('r2');
    expect(created).toEqual([
      [R2.R2_ENDPOINT, R2.R2_ACCESS_KEY_ID, R2.R2_SECRET_ACCESS_KEY],
    ]);
  });

  it('refuses the public media bucket instead of reading from it', () => {
    for (const bucket of ['exom-media-dev', 'exom-media']) {
      expect(
        resolveBasePdfSource(envOf({ ...R2, R2_BASE_PDF_BUCKET: bucket })),
      ).toEqual({ kind: 'unconfigured', reason: 'MEDIA_BUCKET_REJECTED' });
    }
  });

  it('never falls back to the local directory when the bucket is misconfigured', () => {
    expect(
      resolveBasePdfSource(
        envOf({
          R2_BASE_PDF_BUCKET: 'exom-base-pdfs',
          BASE_PDF_LOCAL_DIR: '/tmp/pdfs',
          NODE_ENV: 'development',
        }),
      ),
    ).toEqual({ kind: 'unconfigured', reason: 'R2_CREDENTIALS_MISSING' });
  });

  it('uses the local directory only outside production', () => {
    expect(
      resolveBasePdfSource(
        envOf({ BASE_PDF_LOCAL_DIR: '/tmp/pdfs', NODE_ENV: 'development' }),
      ).kind,
    ).toBe('local');
    expect(
      resolveBasePdfSource(
        envOf({ BASE_PDF_LOCAL_DIR: '/tmp/pdfs', NODE_ENV: 'production' }),
      ),
    ).toEqual({ kind: 'unconfigured', reason: 'NOT_CONFIGURED' });
  });

  it('is unconfigured with nothing set, even with the media bucket configured', () => {
    expect(resolveBasePdfSource(envOf({ ...R2 }))).toEqual({
      kind: 'unconfigured',
      reason: 'NOT_CONFIGURED',
    });
  });
});

describe('BasePdfSourceProvider', () => {
  it('throws BaseSourceNotConfiguredError when unconfigured', () => {
    const provider = new BasePdfSourceProvider(new ConfigService({}));
    expect(provider.kind).toBe('unconfigured');
    expect(() => provider.source()).toThrow(BaseSourceNotConfiguredError);
  });

  it('returns the local source in development', () => {
    const provider = new BasePdfSourceProvider(
      new ConfigService({
        BASE_PDF_LOCAL_DIR: '/tmp/pdfs',
        NODE_ENV: 'development',
      }),
    );
    expect(provider.source()).toBeInstanceOf(LocalDirBasePdfSource);
  });
});

describe('R2BasePdfSource', () => {
  function client(handler: (command: unknown) => Promise<unknown>) {
    const s3 = new S3Client({
      region: 'auto',
      endpoint: 'https://storage.example.test',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    const send = jest.fn<Promise<unknown>, [unknown]>(handler);
    // Stub the Promise form the source uses, as multipart-transfer specs do.
    Object.defineProperty(s3, 'send', { value: send, configurable: true });
    return { s3, send };
  }

  it('lists every page of the bucket and skips folder markers', async () => {
    const fake = client((command) => {
      if (!(command instanceof ListObjectsV2Command)) throw Error('unexpected');
      expect(command.input.Bucket).toBe('exom-base-pdfs');
      return Promise.resolve(
        command.input.ContinuationToken
          ? { Contents: [{ Key: 'nutricion/b.pdf' }], IsTruncated: false }
          : {
              Contents: [{ Key: 'entrenamiento/' }, { Key: 'a/x.pdf' }],
              IsTruncated: true,
              NextContinuationToken: 'next',
            },
      );
    });
    const source = new R2BasePdfSource(fake.s3, 'exom-base-pdfs');
    await expect(source.list()).resolves.toEqual([
      'a/x.pdf',
      'nutricion/b.pdf',
    ]);
    expect(fake.send).toHaveBeenCalledTimes(2);
  });

  it('reads object bytes', async () => {
    const fake = client((command) => {
      if (!(command instanceof GetObjectCommand)) throw Error('unexpected');
      expect(command.input).toEqual({ Bucket: 'b', Key: 'nutricion/x.pdf' });
      return Promise.resolve({
        ContentLength: 3,
        Body: {
          transformToByteArray: () => Promise.resolve(Buffer.from('pdf')),
        },
      });
    });
    const bytes = await new R2BasePdfSource(fake.s3, 'b').get(
      'nutricion/x.pdf',
    );
    expect(bytes.toString()).toBe('pdf');
  });

  it('maps a missing object to SOURCE_NOT_FOUND', async () => {
    const fake = client(() =>
      Promise.reject(
        Object.assign(new Error('missing'), {
          name: 'NoSuchKey',
          $metadata: { httpStatusCode: 404 },
        }),
      ),
    );
    await expect(
      new R2BasePdfSource(fake.s3, 'b').get('nutricion/x.pdf'),
    ).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND' });
  });

  it('rejects unsafe keys before calling storage', async () => {
    const fake = client(() => Promise.resolve({}));
    await expect(
      new R2BasePdfSource(fake.s3, 'b').get('../secret'),
    ).rejects.toBeInstanceOf(BaseServiceError);
    expect(fake.send).not.toHaveBeenCalled();
  });

  it('propagates other storage errors (retryable)', async () => {
    const fake = client(() => Promise.reject(new Error('socket hang up')));
    await expect(
      new R2BasePdfSource(fake.s3, 'b').get('nutricion/x.pdf'),
    ).rejects.toThrow('socket hang up');
  });
});
