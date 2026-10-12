import {
  FeedbackKind,
  FeedbackStatus,
  MediaType,
  Prisma,
  Role,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { FeedbackService } from './feedback.service';
import type { UploadsService } from '../uploads/uploads.service';
import { loadTrainingHistory } from '../../common/progress/training-history';

jest.mock('../../common/progress/training-history', () => ({
  loadTrainingHistory: jest.fn(),
}));

describe('FeedbackService', () => {
  let service: FeedbackService;
  let prisma: {
    $transaction: jest.Mock;
    $queryRaw: jest.Mock;
    feedbackMedia: {
      create: jest.Mock;
      findUnique: jest.Mock;
      findFirst: jest.Mock;
    };
    planAssignment: {
      findUnique: jest.Mock;
    };
    dayProgress: {
      findUnique: jest.Mock;
    };
    trainingExercise: {
      findFirst: jest.Mock;
    };
    adminClientAssignment: {
      findMany: jest.Mock;
    };
  };
  let notifications: {
    queueTemplate: jest.Mock;
  };
  let uploadsService: {
    prepareForConsumption: jest.Mock;
    consumePrepared: jest.Mock;
  };

  beforeEach(() => {
    prisma = {
      $transaction: jest.fn(),
      feedbackMedia: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
      },
      dayProgress: { findUnique: jest.fn() },
      $queryRaw: jest.fn(),
      planAssignment: {
        findUnique: jest.fn(),
      },
      trainingExercise: {
        findFirst: jest.fn(),
      },
      adminClientAssignment: {
        findMany: jest.fn(),
      },
    };
    notifications = {
      queueTemplate: jest.fn().mockResolvedValue({
        success: true,
        sent: 1,
        failed: 0,
      }),
    };
    uploadsService = {
      prepareForConsumption: jest.fn().mockResolvedValue({
        id: 'upload-1',
        file_url: 'https://cdn.exom.dev/feedback_video/client-1/video.mp4',
      }),
      consumePrepared: jest.fn().mockResolvedValue(undefined),
    };
    prisma.$transaction.mockImplementation(
      async (callback: (tx: typeof prisma) => unknown) =>
        await callback(prisma),
    );
    jest.mocked(loadTrainingHistory).mockReset();

    service = new FeedbackService(
      prisma as unknown as PrismaService,
      notifications as unknown as NotificationsService,
      uploadsService as unknown as UploadsService,
    );
  });

  it('notifies assigned admins when a client uploads feedback', async () => {
    prisma.feedbackMedia.create.mockResolvedValue({
      id: 'feedback-1',
      client_id: 'client-1',
      media_type: MediaType.VIDEO,
      media_url: 'https://cdn.exom.dev/feedback_video/client-1/video.mp4',
      notes: 'Revisar técnica',
      status: FeedbackStatus.PENDING,
    });
    prisma.adminClientAssignment.findMany.mockResolvedValue([
      {
        admin_id: 'admin-1',
        client: {
          email: 'client-1@exom.dev',
          profile: {
            first_name: 'Ada',
            last_name: 'Rivera',
          },
        },
      },
      {
        admin_id: 'admin-2',
        client: {
          email: 'client-1@exom.dev',
          profile: {
            first_name: 'Ada',
            last_name: 'Rivera',
          },
        },
      },
    ]);

    await expect(
      service.create('client-1', {
        media_type: MediaType.VIDEO,
        media_url: 'https://cdn.exom.dev/feedback_video/client-1/video.mp4',
        notes: 'Revisar técnica',
      }),
    ).resolves.toMatchObject({ id: 'feedback-1' });

    expect(prisma.feedbackMedia.create).toHaveBeenCalledWith({
      data: {
        client_id: 'client-1',
        media_type: MediaType.VIDEO,
        media_url: 'https://cdn.exom.dev/feedback_video/client-1/video.mp4',
        notes: 'Revisar técnica',
        status: FeedbackStatus.PENDING,
      },
    });
    expect(uploadsService.prepareForConsumption).toHaveBeenCalledWith({
      ownerId: 'client-1',
      uploadId: undefined,
      legacyUrl: 'https://cdn.exom.dev/feedback_video/client-1/video.mp4',
      purposes: ['FEEDBACK_VIDEO'],
    });
    expect(uploadsService.consumePrepared).toHaveBeenCalledWith(
      prisma,
      'client-1',
      'upload-1',
      ['FEEDBACK_VIDEO'],
    );
    expect(prisma.adminClientAssignment.findMany).toHaveBeenCalledWith({
      where: {
        client_id: 'client-1',
        is_active: true,
        admin: {
          is: {
            role: Role.ADMIN,
            is_active: true,
          },
        },
      },
      select: {
        admin_id: true,
        client: {
          select: {
            email: true,
            profile: {
              select: {
                first_name: true,
                last_name: true,
              },
            },
          },
        },
      },
    });
    expect(notifications.queueTemplate).toHaveBeenCalledWith(
      expect.anything(),
      'client-1',
      ['admin-1', 'admin-2'],
      'admin_feedback_submitted',
      {
        clientName: 'Ada Rivera',
        clientId: 'client-1',
        feedbackId: 'feedback-1',
      },
      {
        title: 'Nuevo feedback de cliente',
        body: 'Ada Rivera subi\u00f3 feedback',
        route: '/admin/feedback/feedback-1',
      },
      {
        type: 'feedback_submitted',
        feedback_id: 'feedback-1',
        client_id: 'client-1',
      },
    );
  });

  it.each([
    ['session-1', 'session-1'],
    [undefined, undefined],
  ])(
    'persists last-set video identity with training session %s',
    async (trainingSessionId, expectedSessionId) => {
      prisma.feedbackMedia.findUnique.mockResolvedValue(null);
      prisma.planAssignment.findUnique.mockResolvedValue({
        trainings: [{ requires_last_set_video: true }],
      });
      jest.mocked(loadTrainingHistory).mockResolvedValue(new Map());
      prisma.trainingExercise.findFirst.mockResolvedValue({ id: 'te-1' });
      prisma.feedbackMedia.create.mockResolvedValue({ id: 'feedback-1' });
      prisma.adminClientAssignment.findMany.mockResolvedValue([]);

      await service.create('client-1', {
        feedback_kind: FeedbackKind.LAST_SET,
        media_type: MediaType.VIDEO,
        upload_id: 'upload-1',
        client_upload_id: 'video-1',
        training_session_id: trainingSessionId,
        training_id: 'training-1',
        training_exercise_id: 'te-1',
        exercise_id: 'exercise-1',
        assignment_date: '2026-09-23',
      });

      if (trainingSessionId) {
        expect(prisma.dayProgress.findUnique).toHaveBeenCalled();
        expect(prisma.feedbackMedia.findFirst).toHaveBeenCalled();
      }
      expect(uploadsService.prepareForConsumption).toHaveBeenCalledWith({
        ownerId: 'client-1',
        uploadId: 'upload-1',
        legacyUrl: undefined,
        purposes: ['FEEDBACK_VIDEO'],
      });
      expect(uploadsService.consumePrepared).toHaveBeenCalledWith(
        prisma,
        'client-1',
        'upload-1',
        ['FEEDBACK_VIDEO'],
      );
      expect(prisma.feedbackMedia.create).toHaveBeenCalledWith({
        data: {
          client_id: 'client-1',
          client_upload_id: 'video-1',
          exercise_id: 'exercise-1',
          training_id: 'training-1',
          training_exercise_id: 'te-1',
          ...(expectedSessionId && { training_session_id: expectedSessionId }),
          assignment_date: new Date('2026-09-23T00:00:00.000Z'),
          feedback_kind: FeedbackKind.LAST_SET,
          media_type: MediaType.VIDEO,
          media_url: 'https://cdn.exom.dev/feedback_video/client-1/video.mp4',
          notes: undefined,
          status: FeedbackStatus.PENDING,
        },
      });
    },
  );

  it.each([
    [
      'exercise entry',
      {
        exercises_completed: [
          {
            training_session_id: 'session-1',
            training_exercise_id: 'other-te',
          },
        ],
        training_sessions: [],
      },
      null,
    ],
    [
      'confirmed session',
      {
        exercises_completed: [],
        training_sessions: [
          { training_session_id: 'session-1', training_id: 'other-training' },
        ],
      },
      null,
    ],
    [
      'prior feedback',
      null,
      {
        training_id: 'other-training',
        assignment_date: new Date('2026-09-23T00:00:00.000Z'),
      },
    ],
  ])(
    'rejects a conflicting %s before consuming upload',
    async (_label, progress, priorFeedback) => {
      prisma.planAssignment.findUnique.mockResolvedValue({ trainings: [{}] });
      jest.mocked(loadTrainingHistory).mockResolvedValue(new Map());
      prisma.trainingExercise.findFirst
        .mockResolvedValueOnce({ id: 'te-1' })
        .mockResolvedValue({ training_id: 'other-training' });
      prisma.dayProgress.findUnique.mockResolvedValue(progress);
      prisma.feedbackMedia.findFirst.mockResolvedValue(priorFeedback);
      await expect(
        service.create('client-1', {
          feedback_kind: FeedbackKind.LAST_SET,
          media_type: MediaType.VIDEO,
          upload_id: 'upload-1',
          client_upload_id: 'video-1',
          training_session_id: 'session-1',
          training_id: 'training-1',
          training_exercise_id: 'te-1',
          exercise_id: 'exercise-1',
          assignment_date: '2026-09-23',
        }),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'TRAINING_SESSION_CONFLICT' },
      });
      expect(uploadsService.consumePrepared).not.toHaveBeenCalled();
      expect(prisma.feedbackMedia.create).not.toHaveBeenCalled();
    },
  );

  it('rejects an unresolvable exercise occurrence claiming the same session before consumption', async () => {
    prisma.planAssignment.findUnique.mockResolvedValue({ trainings: [{}] });
    jest.mocked(loadTrainingHistory).mockResolvedValue(new Map());
    prisma.trainingExercise.findFirst
      .mockResolvedValueOnce({ id: 'te-1' })
      .mockResolvedValueOnce(null);
    prisma.dayProgress.findUnique.mockResolvedValue({
      exercises_completed: [
        {
          training_session_id: 'session-1',
          training_exercise_id: 'deleted-te',
        },
      ],
      training_sessions: [],
    });
    prisma.feedbackMedia.findFirst.mockResolvedValue(null);
    prisma.feedbackMedia.create.mockResolvedValue({ id: 'feedback-1' });
    prisma.adminClientAssignment.findMany.mockResolvedValue([]);

    await expect(
      service.create('client-1', {
        feedback_kind: FeedbackKind.LAST_SET,
        media_type: MediaType.VIDEO,
        upload_id: 'upload-1',
        client_upload_id: 'video-1',
        training_session_id: 'session-1',
        training_id: 'training-1',
        training_exercise_id: 'te-1',
        exercise_id: 'exercise-1',
        assignment_date: '2026-09-23',
      }),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'TRAINING_SESSION_CONFLICT' },
    });
    expect(uploadsService.consumePrepared).not.toHaveBeenCalled();
    expect(prisma.feedbackMedia.create).not.toHaveBeenCalled();
  });

  it('accepts a resolvable same-training session exercise', async () => {
    prisma.planAssignment.findUnique.mockResolvedValue({ trainings: [{}] });
    jest.mocked(loadTrainingHistory).mockResolvedValue(new Map());
    prisma.trainingExercise.findFirst
      .mockResolvedValueOnce({ id: 'te-1' })
      .mockResolvedValueOnce({ training_id: 'training-1' });
    prisma.dayProgress.findUnique.mockResolvedValue({
      exercises_completed: [
        {
          training_session_id: 'session-1',
          training_exercise_id: 'existing-te',
        },
      ],
      training_sessions: [],
    });
    prisma.feedbackMedia.findFirst.mockResolvedValue(null);
    prisma.feedbackMedia.create.mockResolvedValue({ id: 'feedback-1' });
    prisma.adminClientAssignment.findMany.mockResolvedValue([]);

    await expect(
      service.create('client-1', {
        feedback_kind: FeedbackKind.LAST_SET,
        media_type: MediaType.VIDEO,
        upload_id: 'upload-1',
        client_upload_id: 'video-1',
        training_session_id: 'session-1',
        training_id: 'training-1',
        training_exercise_id: 'te-1',
        exercise_id: 'exercise-1',
        assignment_date: '2026-09-23',
      }),
    ).resolves.toMatchObject({ id: 'feedback-1' });
    expect(uploadsService.consumePrepared).toHaveBeenCalledTimes(1);
    expect(prisma.feedbackMedia.create).toHaveBeenCalledTimes(1);
  });

  it('does not attach a supplied training session to general feedback', async () => {
    prisma.feedbackMedia.create.mockResolvedValue({ id: 'feedback-1' });
    prisma.adminClientAssignment.findMany.mockResolvedValue([]);

    await service.create('client-1', {
      media_type: MediaType.VIDEO,
      upload_id: 'upload-1',
      client_upload_id: 'video-1',
      training_session_id: 'session-1',
    });

    expect(prisma.feedbackMedia.create).toHaveBeenCalledWith({
      data: {
        client_id: 'client-1',
        client_upload_id: 'video-1',
        media_type: MediaType.VIDEO,
        media_url: 'https://cdn.exom.dev/feedback_video/client-1/video.mp4',
        notes: undefined,
        status: FeedbackStatus.PENDING,
      },
    });
  });

  it('returns existing feedback for a repeated client upload id', async () => {
    prisma.feedbackMedia.findUnique.mockResolvedValue({
      id: 'feedback-existing',
      client_id: 'client-1',
      client_upload_id: 'upload-1',
    });

    await expect(
      service.create('client-1', {
        client_upload_id: 'upload-1',
        media_type: MediaType.VIDEO,
        media_url: 'https://cdn.exom.dev/video.mp4',
      }),
    ).resolves.toMatchObject({ id: 'feedback-existing' });

    expect(prisma.feedbackMedia.create).not.toHaveBeenCalled();
    expect(notifications.queueTemplate).not.toHaveBeenCalled();
  });

  it('refuses to reuse a last-set upload across training sessions', async () => {
    prisma.feedbackMedia.findUnique.mockResolvedValue({
      id: 'feedback-existing',
      client_id: 'client-1',
      client_upload_id: 'video-1',
      feedback_kind: FeedbackKind.LAST_SET,
      training_session_id: 'session-1',
      training_id: 'training-1',
      training_exercise_id: 'te-1',
      assignment_date: new Date('2026-09-23T00:00:00.000Z'),
    });
    await expect(
      service.create('client-1', {
        client_upload_id: 'video-1',
        feedback_kind: FeedbackKind.LAST_SET,
        training_session_id: 'session-2',
        training_id: 'training-1',
        training_exercise_id: 'te-1',
        assignment_date: '2026-09-23',
        exercise_id: 'exercise-1',
        media_type: MediaType.VIDEO,
      }),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'FEEDBACK_UPLOAD_CONFLICT' },
    });
    expect(prisma.feedbackMedia.create).not.toHaveBeenCalled();
    expect(uploadsService.consumePrepared).not.toHaveBeenCalled();
  });

  it('returns the winner when concurrent client upload ids race', async () => {
    const existing = {
      id: 'feedback-existing',
      client_id: 'client-1',
      client_upload_id: 'upload-1',
    };
    prisma.feedbackMedia.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(existing);
    prisma.$transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('duplicate feedback upload', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    await expect(
      service.create('client-1', {
        client_upload_id: 'upload-1',
        media_type: MediaType.VIDEO,
        media_url: 'https://cdn.exom.dev/video.mp4',
      }),
    ).resolves.toEqual(existing);

    expect(prisma.feedbackMedia.findUnique).toHaveBeenCalledTimes(2);
    expect(notifications.queueTemplate).not.toHaveBeenCalled();
  });
});
