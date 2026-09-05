import {
  ExecutionContext,
  HttpStatus,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../prisma/prisma.service';
import { FirebaseAuthGuard } from './firebase-auth.guard';

const verifyIdTokenMock = jest.fn();

jest.mock('firebase-admin', () => ({
  auth: () => ({ verifyIdToken: verifyIdTokenMock }),
}));

describe('FirebaseAuthGuard', () => {
  const reflector = {
    getAllAndOverride: jest.fn().mockReturnValue(false),
  };
  const prisma = {
    user: { findUnique: jest.fn() },
  };
  const config = {
    get: jest.fn().mockReturnValue(undefined),
  };
  let guard: FirebaseAuthGuard;

  beforeEach(() => {
    verifyIdTokenMock.mockReset();
    prisma.user.findUnique.mockReset();
    guard = new FirebaseAuthGuard(
      reflector as unknown as Reflector,
      prisma as unknown as PrismaService,
      config as unknown as ConfigService,
    );
  });

  function context(): ExecutionContext {
    return {
      getHandler: () => context,
      getClass: () => FirebaseAuthGuard,
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { authorization: 'Bearer id-token' },
        }),
      }),
    } as unknown as ExecutionContext;
  }

  it('returns 401 only for a concrete Firebase token rejection', async () => {
    verifyIdTokenMock.mockRejectedValue(
      Object.assign(new Error('invalid token'), {
        code: 'auth/invalid-id-token',
      }),
    );

    await expect(guard.canActivate(context())).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('returns 503 for a temporary Firebase verification failure', async () => {
    verifyIdTokenMock.mockRejectedValue(
      Object.assign(new Error('firebase unavailable'), {
        code: 'auth/internal-error',
      }),
    );

    await expect(guard.canActivate(context())).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('preserves 423 for a locked backend account', async () => {
    verifyIdTokenMock.mockResolvedValue({ uid: 'firebase-user' });
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'client@exom.dev',
      role: 'CLIENT',
      firebase_uid: 'firebase-user',
      is_active: true,
      is_locked: true,
    });

    await expect(guard.canActivate(context())).rejects.toMatchObject({
      status: HttpStatus.LOCKED,
    });
  });
});
