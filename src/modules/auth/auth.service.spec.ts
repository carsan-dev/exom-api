import { HttpException, HttpStatus, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';

const createCustomTokenMock = jest.fn();
const verifyIdTokenMock = jest.fn();

jest.mock('firebase-admin', () => ({
  auth: () => ({
    createCustomToken: createCustomTokenMock,
    verifyIdToken: verifyIdTokenMock,
  }),
}));

describe('AuthService', () => {
  let service: AuthService;
  let prisma: {
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
    global.fetch = jest.fn() as jest.Mock;

    prisma = {
      user: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
      },
    };

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
    createCustomTokenMock.mockResolvedValue('custom-token-1');

    const result = await service.login(dto);

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

  it('throws when getMe cannot find the user', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(service.getMe('missing')).rejects.toThrow(
      new UnauthorizedException('Usuario no encontrado'),
    );
  });
});
