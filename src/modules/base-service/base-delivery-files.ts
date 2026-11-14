import { createHash } from 'node:crypto';
import {
  buildDeliveryPackage,
  DeliveryPackage,
  DeliveryPackageInput,
  PdfStampFn,
} from './base-delivery-package';
import { BasePdfSource } from './base-pdf-source';

/**
 * One recorded PDF. `filename`, `source_key` and `source_sha256` (the
 * catalogue file) are fixed for the whole delivery. `sha256`/`size` describe
 * the stamped attachment of ONE send: `base_deliveries.files` keeps those of
 * the original send, and every send records its own in its work payload
 * (they change with the recipient or with the stamping library/font).
 */
export interface RecordedDeliveryFile {
  filename: string;
  source_key: string;
  source_sha256: string;
  sha256: string;
  size: number;
}

export interface PreparedDelivery {
  recorded: RecordedDeliveryFile[];
  package: DeliveryPackage;
}

export class DeliveryFilesMismatchError extends Error {
  constructor() {
    super('BASE_SOURCE_CHANGED');
    this.name = 'DeliveryFilesMismatchError';
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Builds the stamped package and records what it was built from. */
export async function prepareDeliveryFiles(
  source: BasePdfSource,
  input: DeliveryPackageInput,
  stamp?: PdfStampFn,
): Promise<PreparedDelivery> {
  const sourceHashes = new Map<string, string>();
  const hashing: BasePdfSource = {
    list: () => source.list(),
    get: async (key) => {
      const bytes = await source.get(key);
      sourceHashes.set(key, sha256(bytes));
      return bytes;
    },
  };
  const built = await buildDeliveryPackage(hashing, input, stamp);
  return {
    package: built,
    recorded: built.files.map((file) => ({
      filename: file.filename,
      source_key: file.sourceKey,
      source_sha256: sourceHashes.get(file.sourceKey) ?? '',
      sha256: file.sha256,
      size: file.bytes.byteLength,
    })),
  };
}

function isRecordedFile(value: unknown): value is RecordedDeliveryFile {
  return (
    typeof value === 'object' &&
    value !== null &&
    'filename' in value &&
    typeof value.filename === 'string' &&
    'source_key' in value &&
    typeof value.source_key === 'string' &&
    'source_sha256' in value &&
    typeof value.source_sha256 === 'string' &&
    'sha256' in value &&
    typeof value.sha256 === 'string' &&
    'size' in value &&
    typeof value.size === 'number'
  );
}

/** Parses `base_deliveries.files`; null when the stored shape is unexpected. */
export function parseRecordedFiles(
  value: unknown,
): RecordedDeliveryFile[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const files: RecordedDeliveryFile[] = [];
  for (const entry of value) {
    if (!isRecordedFile(entry)) return null;
    files.push({
      filename: entry.filename,
      source_key: entry.source_key,
      source_sha256: entry.source_sha256,
      sha256: entry.sha256,
      size: entry.size,
    });
  }
  return files;
}

/**
 * Every attempt of ONE send must attach exactly what that send recorded: same
 * files, same source bytes and same stamped bytes, hence the same provider
 * request body under the same Idempotency-Key. Not used across sends.
 */
export function assertMatchesRecorded(
  recorded: readonly RecordedDeliveryFile[],
  prepared: PreparedDelivery,
): void {
  const now = prepared.recorded;
  const same =
    now.length === recorded.length &&
    now.every(
      (file, index) =>
        file.filename === recorded[index].filename &&
        file.source_key === recorded[index].source_key &&
        file.source_sha256 === recorded[index].source_sha256 &&
        file.sha256 === recorded[index].sha256 &&
        file.size === recorded[index].size,
    );
  if (!same) throw new DeliveryFilesMismatchError();
}

/**
 * Same catalogue material as the delivery: same files in the same order and
 * byte-identical sources. Stamped hashes are ignored (they belong to a send).
 */
export function sameSources(
  delivery: readonly RecordedDeliveryFile[],
  candidate: readonly RecordedDeliveryFile[],
): boolean {
  return (
    candidate.length === delivery.length &&
    candidate.every(
      (file, index) =>
        file.filename === delivery[index].filename &&
        file.source_key === delivery[index].source_key &&
        file.source_sha256 === delivery[index].source_sha256,
    )
  );
}
