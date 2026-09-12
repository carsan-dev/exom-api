import { expect } from '@jest/globals';
import {
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { EmailService } from '../email/email.service';

const createCustomTokenMock = jest.fn();
const verifyIdTokenMock = jest.fn();
const queueEmailMock = jest.fn();

jest.mock('firebase-admin', () => ({
  auth: () => ({
    createCustomToken: createCustomTokenMock,
    verifyIdToken: verifyIdTokenMock,
  }),
}));
describe('AuthService', () => {
  let service: AuthService;
  let prisma: {
    $transaction: jest.Mock;
    $queryRaw: jest.Mock;
    user: {
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      update: jest.Mock;
    };
  };
  let config: {
    get: jest.Mock;
  };

  beforeEach(() => {
    createCustomTokenMock.mockReset();
    verifyIdTokenMock.mockReset();
    queueEmailMock.mockReset().mockResolvedValue(undefined);
    global.fetch = jest.fn();

    prisma = {
      $transaction: jest.fn(),
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'user-1' }]),
      user: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
      },
    };

    prisma.$transaction.mockImplementation(
      (work: (tx: typeof prisma) => Promise<unknown>) => work(prisma),
    );

    config = {
      get: jest.fn().mockImplementation((key: string, fallback: string) => {
        if (key === 'LOGIN_MAX_ATTEMPTS') return '3';
        if (key === 'FIREBASE_WEB_API_KEY') return 'test-web-api-key';
        return fallback;
      }),
    };

    service = new AuthService(
      prisma as unknown as PrismaService,
      config as unknown as ConfigService,
      { sendPasswordActionEmail: queueEmailMock } as unknown as EmailService,
    );
  });

  it('returns custom token and basic user payload on login', async () => {
    const dto: LoginDto = {
      email: 'active@exom.dev',
      password: 'super-secret',
    };

    prisma.user.findFirst.mockResolvedValue({
      id: 'user-1',
      email: dto.email,
      is_active: true,
      is_locked: false,
      login_attempts: 0,
      locked_at: null,
      firebase_uid: 'firebase-user-1',
      role: 'CLIENT',
      profile: {
        first_name: 'Active',
        last_name: 'User',
        avatar_url: null,
      },
    });
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          localId: 'firebase-user-1',
          email: dto.email,
        }),
    });
    prisma.user.update.mockResolvedValue({
      id: 'user-1',
      email: dto.email,
      firebase_uid: 'firebase-user-1',
      role: 'CLIENT',
      profile: {
        first_name: 'Active',
        last_name: 'User',
        avatar_url: null,
      },
    });
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      firebase_uid: 'firebase-user-1',
      is_active: true,
      sessions_revoked_at: new Date(100000),
    });
    createCustomTokenMock.mockResolvedValue('custom-token-1');

    const result = await service.login(dto);

    expect(createCustomTokenMock).toHaveBeenCalledWith('firebase-user-1', {
      exom_session_epoch: '100000',
    });
    expect(result).toEqual({
      access_token: 'custom-token-1',
      user: {
        id: 'user-1',
        email: dto.email,
        role: 'CLIENT',
        profile: {
          first_name: 'Active',
          last_name: 'User',
          avatar_url: null,
        },
      },
    });
  });

  it.each(['password', 'social'])(
    'does not mint a custom token after the %s login user has disappeared',
    async (method) => {
      const user = {
        id: 'user-1',
        firebase_uid: 'firebase-user-1',
        email: 'fixture@example.test',
        is_active: true,
        is_locked: false,
        role: 'CLIENT',
        profile: null,
      };
      prisma.user.findFirst.mockResolvedValue(user);
      prisma.user.findUnique.mockResolvedValue(null);
      if (method === 'social')
        prisma.user.findUnique.mockResolvedValueOnce(user);
      prisma.user.update.mockResolvedValue(user);
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ localId: user.firebase_uid }),
      });
      verifyIdTokenMock.mockResolvedValue({
        uid: user.firebase_uid,
        firebase: { sign_in_provider: 'google.com' },
      });
      createCustomTokenMock.mockResolvedValue('must-not-be-issued');
      const result =
        method === 'social'
          ? service.socialLogin({ token: 'fixture', provider: 'google' })
          : service.login({ email: user.email, password: 'fixture' });
      await expect(result).rejects.toBeInstanceOf(UnauthorizedException);
      expect(createCustomTokenMock).not.toHaveBeenCalled();
    },
  );

  it('locks the account after the last failed attempt', async () => {
    const dto: LoginDto = {
      email: 'locked@exom.dev',
      password: 'bad-password',
    };

    prisma.user.findFirst.mockResolvedValue({
      id: 'user-locked',
      email: dto.email,
      is_active: true,
      is_locked: false,
      login_attempts: 2,
      locked_at: null,
      firebase_uid: 'firebase-locked',
      role: 'CLIENT',
      profile: null,
    });
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      json: () =>
        Promise.resolve({
          error: {
            message: 'INVALID_LOGIN_CREDENTIALS',
          },
        }),
    });

    await expect(service.login(dto)).rejects.toThrow(
      new HttpException(
        'Cuenta bloqueada por demasiados intentos — contacta a tu entrenador',
        HttpStatus.LOCKED,
      ),
    );

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-locked' },
      data: {
        login_attempts: 3,
        is_locked: true,
        locked_at: expect.any(Date),
      },
    });
  });

  it('returns the authenticated user data from getMe', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'active@exom.dev',
      role: 'CLIENT',
      profile: {
        first_name: 'Active',
        last_name: 'User',
        avatar_url: null,
      },
    });

    await expect(service.getMe('user-1')).resolves.toEqual({
      id: 'user-1',
      email: 'active@exom.dev',
      role: 'CLIENT',
      profile: {
        first_name: 'Active',
        last_name: 'User',
        avatar_url: null,
      },
    });
  });

  it('returns custom token and user payload on social login when firebase uid matches', async () => {
    verifyIdTokenMock.mockResolvedValue({
      uid: 'firebase-google-1',
      email: 'client@exom.dev',
      firebase: { sign_in_provider: 'google.com' },
    });
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'client@exom.dev',
      is_active: true,
      is_locked: false,
      firebase_uid: 'firebase-google-1',
      role: 'CLIENT',
      profile: {
        first_name: 'Client',
        last_name: 'User',
        avatar_url: null,
      },
    });
    createCustomTokenMock.mockResolvedValue('custom-social-token');

    await expect(
      service.socialLogin({ token: 'token-1', provider: 'google' }),
    ).resolves.toEqual({
      access_token: 'custom-social-token',
      user: {
        id: 'user-1',
        email: 'client@exom.dev',
        role: 'CLIENT',
        profile: {
          first_name: 'Client',
          last_name: 'User',
          avatar_url: null,
        },
      },
    });
  });

  it('links social login when the verified email belongs to an existing user', async () => {
    verifyIdTokenMock.mockResolvedValue({
      uid: 'firebase-google-2',
      email: 'client@exom.dev',
      firebase: { sign_in_provider: 'google.com' },
    });
    prisma.user.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'user-1',
        email: 'client@exom.dev',
        is_active: true,
        is_locked: false,
        firebase_uid: 'firebase-password-1',
        role: 'CLIENT',
        profile: {
          first_name: 'Client',
          last_name: 'User',
          avatar_url: null,
        },
      })
      .mockResolvedValueOnce(null)
      .mockResolvedValue({
        id: 'user-1',
        firebase_uid: 'firebase-google-2',
        is_active: true,
      });
    prisma.user.update.mockResolvedValue({
      id: 'user-1',
      email: 'client@exom.dev',
      is_active: true,
      is_locked: false,
      firebase_uid: 'firebase-google-2',
      role: 'CLIENT',
      profile: {
        first_name: 'Client',
        last_name: 'User',
        avatar_url: null,
      },
    });
    createCustomTokenMock.mockResolvedValue('custom-social-token');

    await expect(
      service.socialLogin({ token: 'token-2', provider: 'google' }),
    ).resolves.toEqual(
      expect.objectContaining({ access_token: 'custom-social-token' }),
    );
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: {
        firebase_uid: 'firebase-google-2',
        auth_provider: 'google',
        login_attempts: 0,
        locked_at: null,
      },
      include: { profile: true },
    });
  });

  it('returns 401 when Firebase rejects a social ID token', async () => {
    verifyIdTokenMock.mockRejectedValue(
      Object.assign(new Error('invalid token'), {
        code: 'auth/invalid-id-token',
      }),
    );

    await expect(
      service.socialLogin({ token: 'bad-token', provider: 'google' }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('returns 503 when social token verification fails temporarily', async () => {
    verifyIdTokenMock.mockRejectedValue(
      Object.assign(new Error('firebase unavailable'), {
        code: 'auth/internal-error',
      }),
    );

    await expect(
      service.socialLogin({ token: 'token-1', provider: 'google' }),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  it('throws when getMe cannot find the user', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(service.getMe('missing')).rejects.toThrow(
      new UnauthorizedException('Usuario no encontrado'),
    );
  });

  it('queues a normalized password reset without contacting a provider', async () => {
    await expect(
      service.forgotPassword('  CLIENT@EXOM.DEV  '),
    ).resolves.toBeUndefined();

    expect(queueEmailMock).toHaveBeenCalledWith(
      'client@exom.dev',
      'password-reset',
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('does not reveal password reset delivery failures', async () => {
    queueEmailMock.mockRejectedValue(Error('queue unavailable'));

    await expect(
      service.forgotPassword('missing@exom.dev'),
    ).resolves.toBeUndefined();
  });
});
