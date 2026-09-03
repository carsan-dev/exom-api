import { BadRequestException } from '@nestjs/common';
import { LastSetVideoPolicy } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { LastSetVideoPolicyService } from './last-set-video-policy.service';

describe('LastSetVideoPolicyService', () => {
  const planAssignment = { findMany: jest.fn() };
  const planAssignmentTraining = { update: jest.fn() };
  const prisma = { planAssignment, planAssignmentTraining };
  const service = new LastSetVideoPolicyService(
    prisma as unknown as PrismaService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    planAssignmentTraining.update.mockResolvedValue({});
  });

  it('uses the natural week containing the first training of the month', async () => {
    planAssignment.findMany.mockResolvedValue([
      {
        date: new Date('2026-09-09T00:00:00.000Z'),
        trainings: [
          {
            id: 'auto-first',
            last_set_video_policy: LastSetVideoPolicy.AUTO,
            requires_last_set_video: false,
          },
          {
            id: 'never-first',
            last_set_video_policy: LastSetVideoPolicy.NEVER,
            requires_last_set_video: true,
          },
        ],
      },
      {
        date: new Date('2026-09-13T00:00:00.000Z'),
        trainings: [
          {
            id: 'auto-same-week',
            last_set_video_policy: LastSetVideoPolicy.AUTO,
            requires_last_set_video: false,
          },
        ],
      },
      {
        date: new Date('2026-09-14T00:00:00.000Z'),
        trainings: [
          {
            id: 'auto-later',
            last_set_video_policy: LastSetVideoPolicy.AUTO,
            requires_last_set_video: true,
          },
          {
            id: 'always-later',
            last_set_video_policy: LastSetVideoPolicy.ALWAYS,
            requires_last_set_video: false,
          },
        ],
      },
    ]);

    await service.reconcile('client-1', ['2026-09']);

    expect(planAssignmentTraining.update.mock.calls).toEqual([
      [{ where: { id: 'auto-first' }, data: { requires_last_set_video: true } }],
      [{ where: { id: 'never-first' }, data: { requires_last_set_video: false } }],
      [{ where: { id: 'auto-same-week' }, data: { requires_last_set_video: true } }],
      [{ where: { id: 'auto-later' }, data: { requires_last_set_video: false } }],
      [{ where: { id: 'always-later' }, data: { requires_last_set_video: true } }],
    ]);
  });

  it('recalculates AUTO after the former first week is removed', async () => {
    planAssignment.findMany.mockResolvedValue([
      {
        date: new Date('2026-09-21T00:00:00.000Z'),
        trainings: [
          {
            id: 'new-first-week',
            last_set_video_policy: LastSetVideoPolicy.AUTO,
            requires_last_set_video: false,
          },
        ],
      },
      {
        date: new Date('2026-09-28T00:00:00.000Z'),
        trainings: [
          {
            id: 'new-later-week',
            last_set_video_policy: LastSetVideoPolicy.AUTO,
            requires_last_set_video: true,
          },
        ],
      },
    ]);

    await service.reconcile('client-1', ['2026-09']);

    expect(planAssignmentTraining.update).toHaveBeenCalledWith({
      where: { id: 'new-first-week' },
      data: { requires_last_set_video: true },
    });
    expect(planAssignmentTraining.update).toHaveBeenCalledWith({
      where: { id: 'new-later-week' },
      data: { requires_last_set_video: false },
    });
  });

  it('rejects requests spanning more than six months', () => {
    expect(() =>
      service.monthsForDates(
        Array.from(
          { length: 7 },
          (_, index) => new Date(Date.UTC(2026, index, 1)),
        ),
      ),
    ).toThrow(BadRequestException);
  });
});
