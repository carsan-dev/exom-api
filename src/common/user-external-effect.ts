import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// Serialize external requests with client deletion. All IDs are locked in the
// same order as deletion; the callback must not open another User write TX.
export function withLiveUsers<T>(
  prisma: PrismaService,
  ids: string[],
  effect: () => Promise<T>,
): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      for (const id of [...new Set(ids)].sort()) {
        const rows = await tx.$queryRaw<
          { id: string }[]
        >`SELECT id FROM users WHERE id = ${id} FOR KEY SHARE`;
        if (!rows.length)
          throw new NotFoundException('La cuenta ya no está disponible');
      }
      return effect();
    },
    { timeout: 300000 },
  );
}
