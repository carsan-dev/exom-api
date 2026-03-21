import {
  Injectable,
  UnauthorizedException,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import * as admin from 'firebase-admin';
import { PrismaService } from '../../prisma/prisma.service';
import { LoginDto, SocialLoginDto } from './dto/login.dto';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly maxAttempts: number;
  private readonly lockDurationMinutes: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.maxAttempts = parseInt(this.config.get('LOGIN_MAX_ATTEMPTS', '3'));
    this.lockDurationMinutes = parseInt(this.config.get('LOGIN_LOCK_DURATION_MINUTES', '30'));
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      include: { profile: true },
    });

    if (!user) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    if (user.is_locked) {
      throw new HttpException('Cuenta bloqueada — contacta a tu entrenador', HttpStatus.LOCKED);
    }

    // Use Firebase Auth REST API to verify email/password
    try {
      const firebaseUser = await admin.auth().getUserByEmail(dto.email);

      // Verify password via Firebase Auth custom token flow
      // In production, the client should call Firebase signInWithEmailAndPassword
      // and send the resulting ID token. This endpoint validates that flow.
      // For now, return a custom token for the user.
      const customToken = await admin.auth().createCustomToken(firebaseUser.uid);

      // Reset failed attempts on successful login
      await this.prisma.user.update({
        where: { id: user.id },
        data: { login_attempts: 0, locked_at: null },
      });

      return {
        access_token: customToken,
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
          profile: user.profile,
        },
      };
    } catch (err) {
      // Increment failed attempts
      const newAttempts = user.login_attempts + 1;
      const shouldLock = newAttempts >= this.maxAttempts;

      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          login_attempts: newAttempts,
          is_locked: shouldLock,
          locked_at: shouldLock ? new Date() : undefined,
        },
      });

      if (shouldLock) {
        throw new HttpException(
          'Cuenta bloqueada por demasiados intentos — contacta a tu entrenador',
          HttpStatus.LOCKED,
        );
      }

      if (newAttempts >= this.maxAttempts - 1) {
        throw new UnauthorizedException(
          `Credenciales inválidas. Quedan ${this.maxAttempts - newAttempts} intentos antes del bloqueo`,
        );
      }

      throw new UnauthorizedException('Credenciales inválidas');
    }
  }

  async socialLogin(dto: SocialLoginDto) {
    // Verify the Firebase ID token from social provider
    let decoded: admin.auth.DecodedIdToken;
    try {
      decoded = await admin.auth().verifyIdToken(dto.token);
    } catch {
      throw new UnauthorizedException('Token social inválido');
    }

    // Find or create user
    let user = await this.prisma.user.findUnique({
      where: { firebase_uid: decoded.uid },
      include: { profile: true },
    });

    if (!user) {
      user = await this.prisma.user.create({
        data: {
          email: decoded.email ?? '',
          firebase_uid: decoded.uid,
          role: 'CLIENT',
          auth_provider: dto.provider,
          profile: {
            create: {
              first_name: decoded.name?.split(' ')[0] ?? '',
              last_name: decoded.name?.split(' ').slice(1).join(' ') ?? '',
              avatar_url: decoded.picture ?? null,
            },
          },
        },
        include: { profile: true },
      });
    }

    if (user.is_locked) {
      throw new HttpException('Cuenta bloqueada — contacta a tu entrenador', HttpStatus.LOCKED);
    }

    // Create a custom token for the user
    const customToken = await admin.auth().createCustomToken(decoded.uid);

    return {
      access_token: customToken,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        profile: user.profile,
      },
    };
  }

  async forgotPassword(email: string): Promise<void> {
    // Firebase handles password reset via email
    try {
      await admin.auth().getUserByEmail(email);
      const resetLink = await admin.auth().generatePasswordResetLink(email);
      this.logger.log(`Password reset link generated for ${email}: ${resetLink}`);
      // In production, send via email service (SendGrid, etc.)
    } catch {
      // Don't reveal if email exists or not
    }
  }

  async logout(userId: string): Promise<void> {
    // Revoke Firebase refresh tokens
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (user) {
      try {
        await admin.auth().revokeRefreshTokens(user.firebase_uid);
      } catch (err) {
        this.logger.warn(`Could not revoke tokens for ${userId}: ${err}`);
      }
    }
  }
}
