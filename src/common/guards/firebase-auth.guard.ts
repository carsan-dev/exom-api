import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import * as admin from 'firebase-admin';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class FirebaseAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers['authorization'];

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Token de autenticación requerido');
    }

    const token = authHeader.split(' ')[1];

    try {
      const decoded = await admin.auth().verifyIdToken(token);

      const user = await this.prisma.user.findUnique({
        where: { firebase_uid: decoded.uid },
        select: {
          id: true,
          email: true,
          role: true,
          firebase_uid: true,
          is_active: true,
          is_locked: true,
        },
      });

      if (!user) {
        // Auto-provision: create CLIENT user on first authenticated request
        const newUser = await this.prisma.user.create({
          data: {
            email: decoded.email ?? '',
            firebase_uid: decoded.uid,
            role: 'CLIENT',
            auth_provider: 'email',
            profile: {
              create: {
                first_name: decoded.name?.split(' ')[0] ?? '',
                last_name: decoded.name?.split(' ').slice(1).join(' ') ?? '',
                avatar_url: decoded.picture ?? null,
              },
            },
          },
          select: {
            id: true,
            email: true,
            role: true,
            firebase_uid: true,
            is_active: true,
            is_locked: true,
          },
        });
        request.user = newUser;
        return true;
      }

      if (!user.is_active) {
        throw new UnauthorizedException('Cuenta inactiva');
      }

      if (user.is_locked) {
        throw new UnauthorizedException('Cuenta bloqueada — contacta a tu entrenador');
      }

      request.user = user;
      return true;
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      throw new UnauthorizedException('Token inválido o expirado');
    }
  }
}
