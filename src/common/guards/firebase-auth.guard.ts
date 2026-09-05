import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import {
  isFirebaseIdTokenRejectedError,
  verifyFirebaseIdTokenWithFallback,
} from '../firebase/firebase-id-token';

@Injectable()
export class FirebaseAuthGuard implements CanActivate {
  private readonly logger = new Logger(FirebaseAuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) return true;

    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: unknown }>();
    const authHeader = request.headers.authorization;

    if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Token de autenticación requerido');
    }

    const token = authHeader.slice('Bearer '.length).trim();
    if (!token) {
      throw new UnauthorizedException('Token de autenticación requerido');
    }

    try {
      const decoded = await verifyFirebaseIdTokenWithFallback({
        token,
        webApiKey: this.config.get<string>('FIREBASE_WEB_API_KEY'),
        restFallbackEnabled:
          this.config
            .get<string>('FIREBASE_AUTH_REST_FALLBACK_ENABLED')
            ?.trim()
            .toLowerCase() === 'true',
        logger: this.logger,
        logContext: 'FirebaseAuthGuard',
      });

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
      if (err instanceof HttpException) {
        throw err;
      }
      if (isFirebaseIdTokenRejectedError(err)) {
        throw new UnauthorizedException('Token inválido o expirado');
      }
      throw new ServiceUnavailableException(
        'No se pudo validar temporalmente la sesión',
      );
    }
  }
}
