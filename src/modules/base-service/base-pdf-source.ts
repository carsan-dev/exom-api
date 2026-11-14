import { readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { BaseServiceError } from './base-service.error';

/**
 * Read-only access to the base-service source PDFs. Keys are relative POSIX
 * paths following the catalogue layout (e.g.
 * `entrenamiento/perder-grasa/EXOM_Entrenamiento_..._Bloque-01.pdf`), which
 * maps one-to-one onto object keys under a prefix in an S3-style bucket.
 */
export interface BasePdfSource {
  /** Every available key (order not significant). */
  list(): Promise<string[]>;
  /** Bytes of one key; rejects with SOURCE_NOT_FOUND when it does not exist. */
  get(key: string): Promise<Buffer>;
}

/** Rejects keys that are not canonical relative POSIX paths. */
export function assertSafeSourceKey(key: string): void {
  const segments = key.split('/');
  const unsafe =
    key.length === 0 ||
    key.includes('\\') ||
    key.includes('\0') ||
    key.startsWith('/') ||
    /^[A-Za-z]:/.test(key) ||
    segments.some(
      (segment) => segment === '' || segment === '.' || segment === '..',
    );
  if (unsafe) {
    throw new BaseServiceError(
      'INVALID_SOURCE_KEY',
      `Clave de origen no válida: «${key}».`,
    );
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return (
    rel !== '' &&
    rel !== '..' &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  );
}

function isNotFound(error: unknown): boolean {
  // Not `instanceof Error`: errors raised by Node core may come from another
  // realm (e.g. under Jest), so check the shape instead.
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

/** {@link BasePdfSource} over a local directory (development and tests). */
export class LocalDirBasePdfSource implements BasePdfSource {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async list(): Promise<string[]> {
    const entries = await readdir(this.root, {
      recursive: true,
      withFileTypes: true,
    });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) =>
        relative(this.root, join(entry.parentPath, entry.name))
          .split(sep)
          .join('/'),
      )
      .sort();
  }

  async get(key: string): Promise<Buffer> {
    assertSafeSourceKey(key);
    const target = resolve(this.root, ...key.split('/'));
    if (!isInside(target, this.root)) {
      throw new BaseServiceError(
        'INVALID_SOURCE_KEY',
        `Clave de origen no válida: «${key}».`,
      );
    }
    try {
      // Also reject symlinks that point outside the root.
      const [realRoot, realTarget] = await Promise.all([
        realpath(this.root),
        realpath(target),
      ]);
      if (!isInside(realTarget, realRoot)) {
        throw new BaseServiceError(
          'INVALID_SOURCE_KEY',
          `Clave de origen no válida: «${key}».`,
        );
      }
      return await readFile(realTarget);
    } catch (error) {
      if (isNotFound(error)) {
        throw new BaseServiceError(
          'SOURCE_NOT_FOUND',
          `No existe el archivo de origen «${key}».`,
        );
      }
      throw error;
    }
  }
}
