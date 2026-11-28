import { expect } from '@jest/globals';
import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { UploadsService } from '../uploads/uploads.service';
import { ClientDeletionService } from '../client-deletion/client-deletion.service';
import { ProfileService } from './profile.service';
import { MarkOnboardingDto } from './dto/mark-onboarding.dto';

describe('ProfileService.markOnboarding', () => {
  const winner = {
    onboarding_completed_at: new Date('2026-11-23T09:00:00.000Z'),
    onboarding_outcome: 'COMPLETED',
  };
  let service: ProfileService;
  let calls: string[];
  let prisma: {
    profile: {
      updateMany: jest.Mock;
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      upsert: jest.Mock;
    };
  };

  beforeEach(async () => {
    calls = [];
    prisma = {
      profile: {
        updateMany: jest.fn(() => {
          calls.push('updateMany');
          return Promise.resolve({ count: 1 });
        }),
        findUnique: jest.fn(() => {
          calls.push('findUnique');
          return Promise.resolve(winner);
        }),
        create: jest.fn(),
        update: jest.fn(),
        upsert: jest.fn(),
      },
    };
    const module = await Test.createTestingModule({
      providers: [
        ProfileService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: new ConfigService() },
        { provide: UploadsService, useValue: {} },
        { provide: ClientDeletionService, useValue: {} },
      ],
    }).compile();
    service = module.get(ProfileService);
  });

  function dto(outcome?: MarkOnboardingDto['outcome']) {
    const value = new MarkOnboardingDto();
    if (outcome !== undefined) value.outcome = outcome;
    return value;
  }

  it('writes only an unmarked profile with one conditional updateMany, then reads the winner', async () => {
    const result = await service.markOnboarding('client-1', dto('COMPLETED'));
    expect(calls).toEqual(['updateMany', 'findUnique']);
    expect(prisma.profile.updateMany).toHaveBeenCalledWith({
      where: { user_id: 'client-1', onboarding_completed_at: null },
      data: {
        onboarding_completed_at: expect.any(Date),
        onboarding_outcome: 'COMPLETED',
      },
    });
    expect(prisma.profile.findUnique).toHaveBeenCalledWith({
      where: { user_id: 'client-1' },
      select: { onboarding_completed_at: true, onboarding_outcome: true },
    });
    expect(result).toEqual(winner);
  });

  it.each([
    ['absent', undefined],
    ['null', null],
  ] as const)(
    'stores a NULL outcome when it is %s',
    async (_label, outcome) => {
      await service.markOnboarding('client-1', dto(outcome));
      expect(prisma.profile.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ onboarding_outcome: null }),
        }),
      );
    },
  );

  it('answers a retry with the persisted winner even when nothing was updated', async () => {
    prisma.profile.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      service.markOnboarding('client-1', dto('SKIPPED')),
    ).resolves.toEqual(winner);
  });

  it('returns 404 for a missing profile and never creates one', async () => {
    prisma.profile.updateMany.mockResolvedValueOnce({ count: 0 });
    prisma.profile.findUnique.mockResolvedValueOnce(null);
    await expect(
      service.markOnboarding('client-1', dto('COMPLETED')),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.profile.create).not.toHaveBeenCalled();
    expect(prisma.profile.upsert).not.toHaveBeenCalled();
    expect(prisma.profile.update).not.toHaveBeenCalled();
  });
});
