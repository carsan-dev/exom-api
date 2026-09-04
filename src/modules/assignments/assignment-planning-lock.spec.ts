import { NotFoundException } from '@nestjs/common';
import { lockAssignmentPlanning } from './assignment-planning-lock';

describe('lockAssignmentPlanning', () => {
  it('rejects a writer when the client disappeared before lock acquisition', async () => {
    const db = { $queryRaw: jest.fn().mockResolvedValue([]) };

    await expect(
      lockAssignmentPlanning(db as never, 'deleted-client'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('continues after locking an existing client row', async () => {
    const db = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'client-1' }]),
    };

    await expect(
      lockAssignmentPlanning(db as never, 'client-1'),
    ).resolves.toBeUndefined();
  });
});
