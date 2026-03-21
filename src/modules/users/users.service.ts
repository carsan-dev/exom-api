import {
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import * as admin from 'firebase-admin';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateClientDto, UpdateRoleDto } from './dto/create-client.dto';
import { PaginationDto, paginate } from '../../common/dto/pagination.dto';
import { Role } from '@prisma/client';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(private readonly prisma: PrismaService) {}

  async findAll(roleFilter?: Role, pagination: PaginationDto = new PaginationDto()) {
    const where = roleFilter ? { role: roleFilter } : {};
    const [data, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        skip: pagination.skip,
        take: pagination.limit,
        select: {
          id: true,
          email: true,
          role: true,
          is_active: true,
          is_locked: true,
          created_at: true,
          profile: { select: { first_name: true, last_name: true, avatar_url: true } },
        },
        orderBy: { created_at: 'desc' },
      }),
      this.prisma.user.count({ where }),
    ]);
    return paginate(data, total, pagination);
  }

  async createClient(adminId: string, dto: CreateClientDto) {
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) throw new ConflictException('El email ya está registrado');

    let firebaseUser: admin.auth.UserRecord;
    try {
      firebaseUser = await admin.auth().createUser({
        email: dto.email,
        password: dto.password,
        displayName: `${dto.first_name} ${dto.last_name}`,
      });
    } catch (err: any) {
      if (err.code === 'auth/email-already-exists') {
        throw new ConflictException('El email ya está registrado en Firebase');
      }
      throw err;
    }

    const user = await this.prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
          email: dto.email,
          firebase_uid: firebaseUser.uid,
          role: Role.CLIENT,
          auth_provider: 'email',
          profile: {
            create: {
              first_name: dto.first_name,
              last_name: dto.last_name,
              level: dto.level ?? 'PRINCIPIANTE',
              main_goal: dto.main_goal ?? null,
            },
          },
        },
        include: { profile: true },
      });

      await tx.adminClientAssignment.create({
        data: { admin_id: adminId, client_id: newUser.id },
      });

      return newUser;
    });

    return {
      id: user.id,
      email: user.email,
      role: user.role,
      is_active: user.is_active,
      is_locked: user.is_locked,
      created_at: user.created_at,
      profile: user.profile,
    };
  }

  async unlockUser(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('Usuario no encontrado');

    await this.prisma.user.update({
      where: { id },
      data: { is_locked: false, login_attempts: 0, locked_at: null },
    });

    return { message: 'Cuenta desbloqueada exitosamente' };
  }

  async updateRole(id: string, dto: UpdateRoleDto) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('Usuario no encontrado');

    await this.prisma.user.update({ where: { id }, data: { role: dto.role } });
    return { message: 'Rol actualizado exitosamente' };
  }

  async getMyClients(adminId: string, pagination: PaginationDto = new PaginationDto()) {
    const [assignments, total] = await Promise.all([
      this.prisma.adminClientAssignment.findMany({
        where: { admin_id: adminId, is_active: true },
        skip: pagination.skip,
        take: pagination.limit,
        include: {
          client: {
            select: {
              id: true,
              email: true,
              role: true,
              is_active: true,
              is_locked: true,
              created_at: true,
              profile: true,
            },
          },
        },
      }),
      this.prisma.adminClientAssignment.count({ where: { admin_id: adminId, is_active: true } }),
    ]);
    return paginate(
      assignments.map((a) => a.client),
      total,
      pagination,
    );
  }

  async updateFcmToken(userId: string, fcmToken: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { fcm_token: fcmToken },
    });
    return { message: 'FCM token updated' };
  }

  async getClientProfile(adminId: string, clientId: string) {
    const assignment = await this.prisma.adminClientAssignment.findFirst({
      where: { admin_id: adminId, client_id: clientId, is_active: true },
    });
    if (!assignment) throw new ForbiddenException('Este cliente no está asignado a ti');

    const client = await this.prisma.user.findUnique({
      where: { id: clientId },
      include: {
        profile: true,
        bodyMetrics: { orderBy: { created_at: 'desc' }, take: 10 },
        streak: true,
      },
    });

    if (!client) throw new NotFoundException('Cliente no encontrado');
    return client;
  }
}
