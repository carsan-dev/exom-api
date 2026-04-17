import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { FeedbackStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { UploadsService } from '../uploads/uploads.service';

const RETENTION_DAYS = 30;
const CLEANUP_BATCH_SIZE = 100;

@Injectable()
export class FeedbackRetentionService {
  private readonly logger = new Logger(FeedbackRetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly uploadsService: UploadsService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async cleanupExpiredFeedbackMedia() {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

    const expiredItems = await this.prisma.feedbackMedia.findMany({
      where: {
        status: FeedbackStatus.REVIEWED,
        reviewed_at: { lte: cutoff },
        media_url: { not: null },
        media_deleted_at: null,
      },
      select: {
        id: true,
        media_url: true,
      },
      orderBy: { reviewed_at: 'asc' },
      take: CLEANUP_BATCH_SIZE,
    });

    if (expiredItems.length === 0) {
      return;
    }

    let deletedCount = 0;

    for (const item of expiredItems) {
      if (!item.media_url) {
        continue;
      }

      try {
        await this.uploadsService.deleteFileByUrl(item.media_url);

        await this.prisma.feedbackMedia.update({
          where: { id: item.id },
          data: {
            media_url: null,
            media_deleted_at: new Date(),
          },
        });

        deletedCount += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        this.logger.warn(`No se pudo borrar el archivo multimedia del feedback ${item.id}: ${message}`);
      }
    }

    if (deletedCount > 0) {
      this.logger.log(`Retención de feedback ejecutada: ${deletedCount} archivo(s) eliminados`);
    }
  }
}
