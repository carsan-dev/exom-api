import { BadRequestException } from '@nestjs/common';

interface DateWindow {
  from: string;
  to: string;
}

const invalidCursor = () =>
  new BadRequestException('Invalid training overview cursor');

// The cursor is a keyset marker, not an authorization credential. Callers must
// check access independently before reading data for the requested client.
export function encodeTrainingOverviewCursor(
  clientId: string,
  range: DateWindow,
  lastExerciseId: string,
): string {
  if (typeof lastExerciseId !== 'string' || !lastExerciseId.length)
    throw invalidCursor();
  const token = Buffer.from(
    JSON.stringify({
      v: 1,
      c: clientId,
      f: range.from,
      t: range.to,
      i: lastExerciseId,
    }),
  ).toString('base64url');
  if (token.length > 2048) throw invalidCursor();
  return token;
}

export function decodeTrainingOverviewCursor(
  cursor: string,
  clientId: string,
  range: DateWindow,
): string {
  try {
    if (
      typeof cursor !== 'string' ||
      cursor.length > 2048 ||
      !/^[A-Za-z0-9_-]+$/.test(cursor)
    )
      throw invalidCursor();
    const bytes = Buffer.from(cursor, 'base64url');
    if (bytes.toString('base64url') !== cursor) throw invalidCursor();
    const text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes)) throw invalidCursor();
    const value: unknown = JSON.parse(text);
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !('v' in value) ||
      value.v !== 1 ||
      !('c' in value) ||
      value.c !== clientId ||
      !('f' in value) ||
      value.f !== range.from ||
      !('t' in value) ||
      value.t !== range.to ||
      !('i' in value) ||
      typeof value.i !== 'string' ||
      !value.i.length ||
      Object.keys(value).length !== 5
    )
      throw invalidCursor();
    return value.i;
  } catch {
    throw invalidCursor();
  }
}

// Only invoke for opted-in pagination; the legacy unpaged route is separate.
export function validateTrainingOverviewPage(
  options: { limit?: number; cursor?: string },
  clientId: string,
  range: DateWindow,
): { limit: number; lastExerciseId: string | null } {
  if (options.cursor !== undefined && options.limit === undefined)
    throw new BadRequestException('Invalid page limit');
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new BadRequestException('Invalid page limit');
  return {
    limit,
    lastExerciseId:
      options.cursor === undefined
        ? null
        : decodeTrainingOverviewCursor(options.cursor, clientId, range),
  };
}
