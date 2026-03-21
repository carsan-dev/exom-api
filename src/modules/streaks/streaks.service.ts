import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class StreaksService {
  constructor(private readonly prisma: PrismaService) {}

  async getStreak(clientId: string) {
    const existing = await this.prisma.streak.findUnique({
      where: { client_id: clientId },
    });

    if (existing) {
      return existing;
    }

    return this.prisma.streak.create({
      data: {
        client_id: clientId,
        current_days: 0,
        longest_days: 0,
      },
    });
  }

  async resetStreak(clientId: string) {
    return this.prisma.streak.update({
      where: { client_id: clientId },
      data: { current_days: 0 },
    });
  }
}
