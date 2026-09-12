import { ForbiddenException, Injectable } from '@nestjs/common';
import { FeedbackStatus, Prisma, RecapStatus, Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

type DashboardClientProfile = {
  first_name: string | null;
  last_name: string | null;
  avatar_url: string | null;
};

type DashboardClient = {
  id: string;
  email: string;
  profile: DashboardClientProfile | null;
};

type DashboardActivity = {
  id: string;
  type: 'recap_submitted' | 'feedback_sent' | 'progress_completed' | 'client_created';
  clientId: string;
  clientName: string;
  clientAvatar: string | null;
  description: string;
  createdAt: string;
};

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getAdminDashboard(adminId: string) {
    const admin = await this.prisma.user.findUnique({
      where: { id: adminId },
      select: { role: true },
    });

    if (
      !admin ||
      (admin.role !== Role.ADMIN && admin.role !== Role.SUPER_ADMIN)
    ) {
      throw new ForbiddenException('Access denied');
    }

    const clientWhere = this.buildClientWhere(adminId, admin.role);
    const { start: weekStart, end: weekEnd } = this.getCurrentWeekRange();

    const [
      activeClients,
      totalClients,
      pendingRecaps,
      pendingFeedback,
      lockedAccounts,
      recentRecaps,
      recentFeedback,
      recentProgress,
      recentClients,
      topClients,
    ] = await Promise.all([
      this.prisma.user.count({
        where: {
          ...clientWhere,
          is_active: true,
        },
      }),
      this.prisma.user.count({ where: clientWhere }),
      this.prisma.weeklyRecap.count({
        where: {
          status: RecapStatus.SUBMITTED,
          client: { is: clientWhere },
        },
      }),
      this.prisma.feedbackMedia.count({
        where: {
          status: FeedbackStatus.PENDING,
          client: { is: clientWhere },
        },
      }),
      this.prisma.user.count({
        where: {
          ...clientWhere,
          is_locked: true,
        },
      }),
      this.prisma.weeklyRecap.findMany({
        where: {
          submitted_at: { not: null },
          client: { is: clientWhere },
        },
        orderBy: { submitted_at: 'desc' },
        take: 10,
        select: {
          id: true,
          client_id: true,
          submitted_at: true,
          client: {
            select: {
              id: true,
              email: true,
              profile: {
                select: {
                  first_name: true,
                  last_name: true,
                  avatar_url: true,
                },
              },
            },
          },
        },
      }),
      this.prisma.feedbackMedia.findMany({
        where: { client: { is: clientWhere } },
        orderBy: { created_at: 'desc' },
        take: 10,
        select: {
          id: true,
          client_id: true,
          created_at: true,
          client: {
            select: {
              id: true,
              email: true,
              profile: {
                select: {
                  first_name: true,
                  last_name: true,
                  avatar_url: true,
                },
              },
            },
          },
        },
      }),
      this.prisma.dayProgress.findMany({
        where: {
          training_completed: true,
          client: { is: clientWhere },
        },
        orderBy: { updated_at: 'desc' },
        take: 10,
        select: {
          id: true,
          client_id: true,
          date: true,
          updated_at: true,
          client: {
            select: {
              id: true,
              email: true,
              profile: {
                select: {
                  first_name: true,
                  last_name: true,
                  avatar_url: true,
                },
              },
            },
          },
        },
      }),
      this.prisma.user.findMany({
        where: clientWhere,
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        take: 10,
        select: {
          id: true,
          email: true,
          created_at: true,
          profile: {
            select: {
              first_name: true,
              last_name: true,
              avatar_url: true,
            },
          },
        },
      }),
      this.getTopClients(adminId, admin.role, weekStart, weekEnd),
    ]);

    // Merge the different activity sources into a single chronological feed.
    const recentActivity = [
      ...recentRecaps
        .filter((item) => item.submitted_at)
        .map((item) =>
          this.buildActivity(
            item.id,
            'recap_submitted',
            item.client_id,
            item.client,
            `${this.getClientName(item.client)} envió su recap semanal`,
            item.submitted_at as Date,
          ),
        ),
      ...recentFeedback.map((item) =>
        this.buildActivity(
          item.id,
          'feedback_sent',
          item.client_id,
          item.client,
          `${this.getClientName(item.client)} envió feedback multimedia`,
          item.created_at,
        ),
      ),
      ...recentProgress.map((item) =>
        this.buildActivity(
          item.id,
          'progress_completed',
          item.client_id,
          item.client,
          `${this.getClientName(item.client)} completó su entrenamiento del ${item.date.toISOString().split('T')[0]}`,
          item.updated_at,
        ),
      ),
      ...recentClients.map((item) =>
        this.buildActivity(
          item.id,
          'client_created',
          item.id,
          item,
          `${this.getClientName(item)} se incorporó a EXOM`,
          item.created_at,
        ),
      ),
    ]
      .sort(
        (left, right) =>
          Date.parse(right.createdAt) - Date.parse(left.createdAt),
      )
      .slice(0, 10);

    return {
      stats: {
        activeClients,
        totalClients,
        pendingRecaps,
        pendingFeedback,
        lockedAccounts,
      },
      recentActivity,
      topClients,
    };
  }

  private getTopClients(adminId: string, role: Role, start: Date, end: Date) {
    // ECMAScript trim whitespace, including NBSP/BOM; preserve the display name.
    const whitespace =
      '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
    const scope =
      role === Role.SUPER_ADMIN
        ? Prisma.sql`TRUE`
        : Prisma.sql`EXISTS (
      SELECT 1 FROM admin_client_assignments a WHERE a.client_id=u.id AND a.admin_id=${adminId} AND a.is_active)`;
    return this.prisma.$queryRaw<
      Array<{
        clientId: string;
        clientName: string;
        clientAvatar: string | null;
        completedDays: number;
        currentStreak: number;
      }>
    >(Prisma.sql`
      SELECT u.id AS "clientId", coalesce(nullif(concat_ws(' ', nullif(btrim(p.first_name, ${whitespace}), ''), nullif(btrim(p.last_name, ${whitespace}), '')), ''), u.email) AS "clientName",
        p.avatar_url AS "clientAvatar", d.completed::integer AS "completedDays", coalesce(s.current_days,0) AS "currentStreak"
      FROM (SELECT client_id, count(*) completed FROM day_progress WHERE training_completed AND date>=${start} AND date<=${end} GROUP BY client_id) d
      JOIN users u ON u.id=d.client_id LEFT JOIN profiles p ON p.user_id=u.id LEFT JOIN streaks s ON s.client_id=u.id
      WHERE u.role='CLIENT' AND ${scope}
      ORDER BY d.completed DESC, (coalesce(nullif(concat_ws(' ', nullif(btrim(p.first_name, ${whitespace}), ''), nullif(btrim(p.last_name, ${whitespace}), '')), ''), u.email)) COLLATE public.exom_search_locale, u.id
      LIMIT 5`);
  }

  private buildClientWhere(adminId: string, adminRole: Role): Prisma.UserWhereInput {
    if (adminRole === Role.SUPER_ADMIN) {
      return { role: Role.CLIENT };
    }

    return {
      role: Role.CLIENT,
      clientOf: {
        some: {
          admin_id: adminId,
          is_active: true,
        },
      },
    };
  }

  private buildActivity(
    id: string,
    type: DashboardActivity['type'],
    clientId: string,
    client: DashboardClient,
    description: string,
    createdAt: Date,
  ): DashboardActivity {
    return {
      id,
      type,
      clientId,
      clientName: this.getClientName(client),
      clientAvatar: client.profile?.avatar_url ?? null,
      description,
      createdAt: createdAt.toISOString(),
    };
  }

  private getClientName(client: DashboardClient) {
    const firstName = client.profile?.first_name?.trim();
    const lastName = client.profile?.last_name?.trim();
    const fullName = [firstName, lastName].filter(Boolean).join(' ');

    return fullName || client.email;
  }

  private getCurrentWeekRange() {
    const now = new Date();
    const weekStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const day = weekStart.getUTCDay();
    const diffToMonday = day === 0 ? -6 : 1 - day;

    weekStart.setUTCDate(weekStart.getUTCDate() + diffToMonday);

    const weekEnd = new Date(weekStart);
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
    weekEnd.setUTCHours(23, 59, 59, 999);

    return { start: weekStart, end: weekEnd };
  }
}
