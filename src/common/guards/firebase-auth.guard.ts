import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import * as admin from 'firebase-admin';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class FirebaseAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
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
        throw new UnauthorizedException(
          'Tu cuenta no está autorizada. Contacta con tu entrenador.',
        );
      }

      if (!user.is_active) {
        throw new UnauthorizedException('Cuenta inactiva');
      }

      if (user.is_locked) {
        throw new HttpException(
          'Cuenta bloqueada — contacta a tu entrenador',
          HttpStatus.LOCKED,
        );
      }

      request.user = user;
      return true;
    } catch (err) {
      if (
        err instanceof UnauthorizedException ||
        err instanceof HttpException
      ) {
        throw err;
      }
      throw new UnauthorizedException('Token inválido o expirado');
    }
  }
}
