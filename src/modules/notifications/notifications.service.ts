import { Injectable, Logger } from '@nestjs/common';
import * as admin from 'firebase-admin';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async sendToUser(
    userId: string,
    title: string,
    body: string,
    data?: Record<string, string>,
  ): Promise<{ success: boolean; message: string }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, firebase_uid: true, fcm_token: true },
    });

    if (!user) {
      return { success: false, message: 'User not found' };
    }

    if (!user.fcm_token) {
      this.logger.warn(`No FCM token registered for user ${user.email}`);
      return { success: false, message: 'No FCM token registered for this user' };
    }

    try {
      const messageId = await admin.messaging().send({
        token: user.fcm_token,
        notification: { title, body },
        data: data ?? {},
      });
      this.logger.log(`FCM sent to ${user.email}: ${messageId}`);
      return { success: true, message: messageId };
    } catch (error: any) {
      this.logger.error(`FCM error for ${user.email}: ${error.message}`);
      return { success: false, message: error.message };
    }
  }

  async sendToMultiple(
    userIds: string[],
    title: string,
    body: string,
    data?: Record<string, string>,
  ): Promise<{ success: boolean; sent: number; failed: number }> {
    const results = await Promise.allSettled(
      userIds.map((id) => this.sendToUser(id, title, body, data)),
    );

    const sent = results.filter(
      (r) => r.status === 'fulfilled' && r.value.success,
    ).length;

    const failed = results.length - sent;

    return { success: failed === 0, sent, failed };
  }

  async sendRecapReminder(clientId: string): Promise<{ success: boolean; message: string }> {
    return this.sendToUser(
      clientId,
      'Weekly Recap Reminder',
      "Don't forget to complete your weekly recap!",
      { type: 'recap_reminder' },
    );
  }
}
