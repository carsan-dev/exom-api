import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';

export interface ProgressCommand {
  id: string;
  revision: number;
  payloadHash: string;
}
export const progressCommand = new AsyncLocalStorage<ProgressCommand>();

export function runProgressCommand<T>(
  id: string | undefined,
  revision: string | undefined,
  payload: unknown,
  operation: () => Promise<T>,
): Promise<T> {
  if (id === undefined && revision === undefined) return operation();
  if (
    !id ||
    !/^[a-zA-Z0-9:_-]{1,128}$/.test(id) ||
    revision === undefined ||
    !/^\d+$/.test(revision) ||
    !Number.isSafeInteger(Number(revision))
  ) {
    throw new BadRequestException(
      'Invalid offline operation identity or revision',
    );
  }
  const payloadHash = createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
  return progressCommand.run(
    { id, revision: Number(revision), payloadHash },
    operation,
  );
}
