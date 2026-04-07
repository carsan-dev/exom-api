import { ConflictException, HttpException, HttpStatus, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthService } from './auth.service';
import { CreateTrialUserDto } from './dto/create-trial.dto';
import { LoginDto } from './dto/login.dto';

const createUserMock = jest.fn();
const createCustomTokenMock = jest.fn();
const verifyIdTokenMock = jest.fn();

jest.mock('firebase-admin', () => ({
  auth: () => ({
    createUser: createUserMock,
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
      create: jest.Mock;
      update: jest.Mock;
    };
  };
  let config: {
    get: jest.Mock;
  };

  beforeEach(() => {
    createUserMock.mockReset();
    createCustomTokenMock.mockReset();
    verifyIdTokenMock.mockReset();

    prisma = {
      user: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
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

  // ─── createTrialUser tests ───────────────────────────────────────────────

  it('creates a trial user with LOW_TICKET tier and 14-day expiration', async () => {
    const dto: CreateTrialUserDto = {
      email: 'trial@exom.dev',
      password: 'trial-pass-123',
      first_name: 'Trial',
      last_name: 'User',
    };

    const beforeCreation = new Date();
    const expectedExpiresAfter = new Date(beforeCreation);
    expectedExpiresAfter.setDate(expectedExpiresAfter.getDate() + 14);

    prisma.user.findFirst.mockResolvedValue(null);
    createUserMock.mockResolvedValue({ uid: 'firebase-trial-1' });
    prisma.user.create.mockResolvedValue({
      id: 'trial-user-1',
      email: dto.email,
      role: 'CLIENT',
      tier: 'LOW_TICKET',
      trial_expires_at: expectedExpiresAfter,
      profile: {
        first_name: dto.first_name,
        last_name: dto.last_name,
        avatar_url: null,
      },
    });
    createCustomTokenMock.mockResolvedValue('custom-token-trial');

    const result = await service.createTrialUser(dto);

    expect(result).toEqual({
      access_token: 'custom-token-trial',
      user: {
        id: 'trial-user-1',
        email: dto.email,
        role: 'CLIENT',
        tier: 'LOW_TICKET',
        trial_expires_at: expectedExpiresAfter,
        profile: {
          first_name: dto.first_name,
          last_name: dto.last_name,
          avatar_url: null,
        },
      },
    });

    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tier: 'LOW_TICKET',
          trial_expires_at: expect.any(Date),
        }),
      }),
    );

    const createdData = (prisma.user.create.mock.calls[0] as any)[0].data;
    expect(createdData.trial_expires_at.getTime()).toBeGreaterThanOrEqual(
      expectedExpiresAfter.getTime() - 1000,
    );
  });

  it('throws ConflictException when trial email already exists in DB', async () => {
    const dto: CreateTrialUserDto = {
      email: 'existing@exom.dev',
      password: 'trial-pass-123',
      first_name: 'Existing',
      last_name: 'User',
    };

    prisma.user.findFirst.mockResolvedValue({ id: 'existing-user-1' });

    await expect(service.createTrialUser(dto)).rejects.toThrow(
      new ConflictException('El email ya está registrado'),
    );

    expect(createUserMock).not.toHaveBeenCalled();
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('throws ConflictException when email already exists in Firebase', async () => {
    const dto: CreateTrialUserDto = {
      email: 'firebase-existing@exom.dev',
      password: 'trial-pass-123',
      first_name: 'Firebase',
      last_name: 'User',
    };

    prisma.user.findFirst.mockResolvedValue(null);
    createUserMock.mockRejectedValue({ code: 'auth/email-already-exists' });

    await expect(service.createTrialUser(dto)).rejects.toThrow(
      new ConflictException('El email ya está registrado en Firebase'),
    );
  });

  it('re-throws unexpected Firebase errors during trial creation', async () => {
    const dto: CreateTrialUserDto = {
      email: 'trial-error@exom.dev',
      password: 'trial-pass-123',
      first_name: 'Error',
      last_name: 'User',
    };

    prisma.user.findFirst.mockResolvedValue(null);
    createUserMock.mockRejectedValue(new Error('Unexpected Firebase error'));

    await expect(service.createTrialUser(dto)).rejects.toThrow('Unexpected Firebase error');
  });

  // ─── Trial expired guard in login ────────────────────────────────────────

  it('throws HTTP 402 when trial has expired on login', async () => {
    const dto: LoginDto = {
      email: 'expired-trial@exom.dev',
      password: 'some-password',
    };

    const expiredDate = new Date();
    expiredDate.setDate(expiredDate.getDate() - 1);

    prisma.user.findFirst.mockResolvedValue({
      id: 'expired-trial-user',
      email: dto.email,
      is_active: true,
      is_locked: false,
      login_attempts: 0,
      locked_at: null,
      firebase_uid: 'firebase-expired',
      trial_expires_at: expiredDate,
      tier: 'LOW_TICKET',
      profile: null,
    });

    await expect(service.login(dto)).rejects.toThrow(
      new HttpException(
        'Tu periodo de prueba ha finalizado. Contacta con tu entrenador para acceder al plan completo.',
        HttpStatus.PAYMENT_REQUIRED,
      ),
    );
  });

  // ─── Trial expired guard in getMe ────────────────────────────────────────

  it('throws HTTP 402 when trial has expired on getMe', async () => {
    const expiredDate = new Date();
    expiredDate.setDate(expiredDate.getDate() - 1);

    prisma.user.findUnique.mockResolvedValue({
      id: 'expired-trial-user',
      email: 'expired-trial@exom.dev',
      role: 'CLIENT',
      tier: 'LOW_TICKET',
      trial_expires_at: expiredDate,
      is_active: true,
      profile: null,
    });

    await expect(service.getMe('expired-trial-user')).rejects.toThrow(
      new HttpException(
        'Tu periodo de prueba ha finalizado. Contacta con tu entrenador para acceder al plan completo.',
        HttpStatus.PAYMENT_REQUIRED,
      ),
    );
  });

  // ─── Active trial user can login ─────────────────────────────────────────

  it('allows login for active trial user and returns tier info', async () => {
    const dto: LoginDto = {
      email: 'active-trial@exom.dev',
      password: 'trial-pass-123',
    };

    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 7);

    prisma.user.findFirst.mockResolvedValue({
      id: 'active-trial-user',
      email: dto.email,
      is_active: true,
      is_locked: false,
      login_attempts: 0,
      locked_at: null,
      firebase_uid: 'firebase-active-trial',
      trial_expires_at: futureDate,
      tier: 'LOW_TICKET',
      profile: {
        first_name: 'Active',
        last_name: 'Trial',
        avatar_url: null,
      },
    });

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          localId: 'firebase-active-trial',
          email: dto.email,
        }),
    });

    prisma.user.update.mockResolvedValue({
      id: 'active-trial-user',
      email: dto.email,
      firebase_uid: 'firebase-active-trial',
      tier: 'LOW_TICKET',
      trial_expires_at: futureDate,
      role: 'CLIENT',
      profile: {
        first_name: 'Active',
        last_name: 'Trial',
        avatar_url: null,
      },
    });

    createCustomTokenMock.mockResolvedValue('custom-token-active-trial');

    const result = await service.login(dto);

    expect(result.user.tier).toBe('LOW_TICKET');
    expect(result.user.trial_expires_at).toEqual(futureDate);
  });
});
