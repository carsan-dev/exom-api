import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  Logger,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import * as admin from 'firebase-admin';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { LoginDto, SocialLoginDto } from './dto/login.dto';
import {
  VerifiedFirebaseIdToken,
  verifyFirebaseIdTokenWithFallback,
} from '../../common/firebase/firebase-id-token';

class FirebasePasswordAuthError extends Error {
  constructor(
    readonly firebaseCode?: string,
    readonly firebaseReason?: string,
  ) {
    super('Firebase password authentication failed');
  }
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly maxAttempts: number;
  private readonly firebaseWebApiKey?: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Optional() private readonly emailService?: EmailService,
  ) {
    this.maxAttempts = parseInt(this.config.get('LOGIN_MAX_ATTEMPTS', '3'));
    this.firebaseWebApiKey = this.config.get<string>('FIREBASE_WEB_API_KEY');
  }

  private async signInWithFirebasePassword(email: string, password: string) {
    if (!this.firebaseWebApiKey) {
      throw new InternalServerErrorException(
        'FIREBASE_WEB_API_KEY no está configurada en el backend',
      );
    }

    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${this.firebaseWebApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          returnSecureToken: true,
        }),
      },
    );

    const payload = (await response.json().catch(() => null)) as {
      localId?: string;
      email?: string;
      error?: {
        message?: string;
        details?: Array<{
          reason?: string;
        }>;
      };
    } | null;

    if (!response.ok || !payload?.localId) {
      const firebaseReason = payload?.error?.details?.find(
        (detail) => typeof detail.reason === 'string',
      )?.reason;

      throw new FirebasePasswordAuthError(
        payload?.error?.message,
        firebaseReason,
      );
    }

    return {
      localId: payload.localId,
      email: payload.email ?? email,
    };
  }

  private isCredentialFailure(error: FirebasePasswordAuthError): boolean {
    return [
      'INVALID_LOGIN_CREDENTIALS',
      'INVALID_PASSWORD',
      'EMAIL_NOT_FOUND',
      'INVALID_EMAIL',
    ].includes(error.firebaseReason ?? error.firebaseCode ?? '');
  }

  private rethrowFirebasePasswordError(
    error: FirebasePasswordAuthError,
  ): never {
    const normalizedError = error.firebaseReason ?? error.firebaseCode;

    switch (normalizedError) {
      case 'USER_DISABLED':
        throw new UnauthorizedException('Cuenta inactiva en Firebase');
      case 'TOO_MANY_ATTEMPTS_TRY_LATER':
        throw new HttpException(
          'Firebase ha bloqueado temporalmente el acceso. Inténtalo más tarde.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      case 'OPERATION_NOT_ALLOWED':
        throw new InternalServerErrorException(
          'El login con email y contraseña no está habilitado en Firebase Authentication.',
        );
      case 'API_KEY_ANDROID_APP_BLOCKED':
        throw new InternalServerErrorException(
          'La FIREBASE_WEB_API_KEY del backend es incorrecta. Usa la Web API Key del proyecto en Firebase Console, no la de Android/iOS.',
        );
      case 'API_KEY_INVALID':
      case 'PROJECT_NOT_FOUND':
      case 'CONFIGURATION_NOT_FOUND':
        throw new InternalServerErrorException(
          'La configuración de Firebase del backend no es válida para autenticar con contraseña.',
        );
      default:
        if (
          error.firebaseCode?.includes(
            'Requests from this Android client application',
          )
        ) {
          throw new InternalServerErrorException(
            'La FIREBASE_WEB_API_KEY del backend sigue apuntando a la clave Android. Sustituyela por la Web API Key del proyecto en Firebase Console.',
          );
        }

        this.logger.error(
          `Firebase password login failed with unexpected code: ${normalizedError ?? 'UNKNOWN'}`,
        );
        throw new InternalServerErrorException(
          'No se pudo validar el login contra Firebase.',
        );
    }
  }

  private async ensureFirebaseUidOwnership(
    userId: string,
    firebaseUid: string,
  ) {
    const owner = await this.prisma.user.findUnique({
      where: { firebase_uid: firebaseUid },
      select: { id: true },
    });

    if (owner && owner.id !== userId) {
      throw new ConflictException(
        'La identidad autenticada ya está asociada a otro usuario',
      );
    }
  }

  private expectedSocialProvider(provider: SocialLoginDto['provider']) {
    return provider === 'google' ? 'google.com' : 'apple.com';
  }

  private async findAuthorizedUserForSocialLogin(
    decoded: VerifiedFirebaseIdToken,
    provider: SocialLoginDto['provider'],
  ) {
    let user = await this.prisma.user.findUnique({
      where: { firebase_uid: decoded.uid },
      include: { profile: true },
    });

    if (!user && decoded.email) {
      const normalizedEmail = decoded.email.trim().toLowerCase();
      user = await this.prisma.user.findUnique({
        where: { email: normalizedEmail },
        include: { profile: true },
      });

      if (user) {
        // User exists by email but firebase_uid differs — link the social identity
        await this.ensureFirebaseUidOwnership(user.id, decoded.uid);
        user = await this.prisma.user.update({
          where: { id: user.id },
          data: {
            firebase_uid: decoded.uid,
            auth_provider: provider,
            login_attempts: 0,
            locked_at: null,
          },
          include: { profile: true },
        });
      }
    }

    if (!user) {
      throw new UnauthorizedException(
        'Tu cuenta no está autorizada todavía. Contacta con tu entrenador.',
      );
    }

    return user;
  }

  async login(dto: LoginDto) {
    const normalizedEmail = dto.email.trim().toLowerCase();

    let user = await this.prisma.user.findFirst({
      where: { email: { equals: normalizedEmail, mode: 'insensitive' } },
      include: { profile: true },
    });

    if (!user) {
      throw new UnauthorizedException('Credenciales inválidas');
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

    try {
      const firebaseSession = await this.signInWithFirebasePassword(
        normalizedEmail,
        dto.password,
      );

      if (user.firebase_uid !== firebaseSession.localId) {
        await this.ensureFirebaseUidOwnership(user.id, firebaseSession.localId);
        user = await this.prisma.user.update({
          where: { id: user.id },
          data: {
            firebase_uid: firebaseSession.localId,
            login_attempts: 0,
            locked_at: null,
          },
          include: { profile: true },
        });
      } else {
        user = await this.prisma.user.update({
          where: { id: user.id },
          data: { login_attempts: 0, locked_at: null },
          include: { profile: true },
        });
      }

      const customToken = await admin
        .auth()
        .createCustomToken(user.firebase_uid);

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
      if (!(err instanceof FirebasePasswordAuthError)) {
        throw err;
      }

      if (!this.isCredentialFailure(err)) {
        this.rethrowFirebasePasswordError(err);
      }

      const newAttempts = user.login_attempts + 1;
      const shouldLock = newAttempts >= this.maxAttempts;

      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          login_attempts: newAttempts,
          is_locked: shouldLock,
          locked_at: shouldLock ? new Date() : null,
        },
      });

      if (shouldLock) {
        throw new HttpException(
          'Cuenta bloqueada por demasiados intentos — contacta a tu entrenador',
          HttpStatus.LOCKED,
        );
      }

      const attemptsLeft = this.maxAttempts - newAttempts;
      if (attemptsLeft === 1) {
        throw new UnauthorizedException(
          'Credenciales inválidas. Queda 1 intento antes del bloqueo',
        );
      }

      throw new UnauthorizedException('Credenciales inválidas');
    }
  }

  async socialLogin(dto: SocialLoginDto) {
    let decoded: VerifiedFirebaseIdToken;
    try {
      decoded = await verifyFirebaseIdTokenWithFallback({
        token: dto.token,
        webApiKey: this.firebaseWebApiKey,
        logger: this.logger,
        logContext: 'AuthService.socialLogin',
        expectedProvider: this.expectedSocialProvider(dto.provider),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Firebase social token verification failed: ${message}`,
      );
      throw new UnauthorizedException('Token social inválido');
    }

    const expectedProvider = this.expectedSocialProvider(dto.provider);
    const signInProvider = decoded.firebase?.sign_in_provider;
    if (signInProvider !== expectedProvider) {
      throw new UnauthorizedException(
        'El token social no coincide con el proveedor indicado',
      );
    }

    const user = await this.findAuthorizedUserForSocialLogin(
      decoded,
      dto.provider,
    );

    if (!user.is_active) {
      throw new UnauthorizedException('Cuenta inactiva');
    }

    if (user.is_locked) {
      throw new HttpException(
        'Cuenta bloqueada — contacta a tu entrenador',
        HttpStatus.LOCKED,
      );
    }

    const customToken = await admin.auth().createCustomToken(user.firebase_uid);

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

  async getMe(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { profile: true },
    });

    if (!user) {
      throw new UnauthorizedException('Usuario no encontrado');
    }

    return {
      id: user.id,
      email: user.email,
      role: user.role,
      profile: user.profile,
    };
  }

  async forgotPassword(email: string): Promise<void> {
    const normalizedEmail = email.trim().toLowerCase();

    try {
      if (this.emailService) {
        await this.emailService.sendPasswordActionEmail(
          normalizedEmail,
          'password-reset',
        );
      } else {
        await this.sendPasswordResetEmail(normalizedEmail);
      }
    } catch (err) {
      // Do not reveal whether the email exists.
      this.logger.warn(`Password reset request failed silently: ${err}`);
    }
  }

  private async sendPasswordResetEmail(email: string) {
    if (!this.firebaseWebApiKey) {
      this.logger.warn('FIREBASE_WEB_API_KEY is not configured');
      return;
    }

    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${this.firebaseWebApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestType: 'PASSWORD_RESET',
          email,
        }),
      },
    );

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      this.logger.error(
        `Firebase password reset email failed: ${response.status} ${body}`,
      );
      throw new InternalServerErrorException(
        'No se pudo enviar el email de recuperaci\u00f3n.',
      );
    }
  }

  async logout(userId: string): Promise<void> {
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
