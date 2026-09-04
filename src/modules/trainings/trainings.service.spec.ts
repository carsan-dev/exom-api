import { Level } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { TrainingsQueryDto } from './dto/trainings-query.dto';
import { TrainingsService } from './trainings.service';
import type { AutoAssignmentMaterializerService } from '../assignments/auto-assignment-materializer.service';

describe('TrainingsService', () => {
  let service: TrainingsService;
  let prisma: {
    $transaction: jest.Mock;
    training: {
      findMany: jest.Mock;
      findFirst: jest.Mock;
      count: jest.Mock;
      update: jest.Mock;
    };
    achievement: {
      findMany: jest.Mock;
      update: jest.Mock;
    };
    catalogColor: {
      findMany: jest.Mock;
      upsert: jest.Mock;
    };
    planAssignment: { findUnique: jest.Mock };
    dayProgress: { findUnique: jest.Mock };
  };
  let autoAssignmentMaterializer: { reconcile: jest.Mock };

  beforeEach(() => {
    prisma = {
      $transaction: jest.fn().mockResolvedValue([]),
      training: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        count: jest.fn(),
        update: jest.fn(),
      },
      achievement: {
        findMany: jest.fn(),
        update: jest.fn(),
      },
      catalogColor: {
        findMany: jest.fn(),
        upsert: jest.fn(),
      },
      planAssignment: { findUnique: jest.fn() },
      dayProgress: { findUnique: jest.fn() },
    };

    autoAssignmentMaterializer = {
      reconcile: jest.fn().mockResolvedValue(undefined),
    };
    service = new TrainingsService(
      prisma as unknown as PrismaService,
      autoAssignmentMaterializer as unknown as AutoAssignmentMaterializerService,
    );
  });

  it('builds prisma filters for list mode', async () => {
    const query = Object.assign(new TrainingsQueryDto(), {
      page: 1,
      limit: 20,
      type: ['HIIT'],
      level: [Level.INTERMEDIO],
      tags: ['Core'],
      duration_min: 20,
      duration_max: 40,
    });
    const expectedWhere = {
      is_active: true,
      OR: [{ types: { hasSome: ['HIIT'] } }, { type: { in: ['HIIT'] } }],
      level: { in: [Level.INTERMEDIO] },
      tags: { hasSome: ['Core'] },
      estimated_duration_min: {
        gte: 20,
        lte: 40,
      },
    };

    prisma.training.findMany.mockResolvedValue([
      {
        id: 'training-1',
        type: 'HIIT',
        types: ['HIIT'],
        accentColor: null,
        _count: { exercises: 3 },
      },
    ]);
    prisma.training.count.mockResolvedValue(1);

    await expect(service.findAll(query)).resolves.toEqual({
      data: [
        {
          id: 'training-1',
          type: 'HIIT',
          types: ['HIIT'],
          accentColor: null,
          exercises_count: 3,
        },
      ],
      total: 1,
      page: 1,
      limit: 20,
      totalPages: 1,
    });

    expect(prisma.training.findMany).toHaveBeenCalledWith({
      where: expectedWhere,
      skip: 0,
      take: 20,
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      select: expect.objectContaining({
        _count: { select: { exercises: true } },
      }),
    });
    expect(prisma.training.count).toHaveBeenCalledWith({
      where: expectedWhere,
    });
  });

  it('keeps accent-insensitive search on already filtered trainings', async () => {
    const query = Object.assign(new TrainingsQueryDto(), {
      page: 2,
      limit: 1,
      search: 'movilidad',
      type: ['FLEXIBILIDAD'],
    });

    prisma.training.findMany.mockResolvedValue([
      {
        id: 'training-1',
        name: 'Movilidad articular',
        type: 'FLEXIBILIDAD',
        types: ['FLEXIBILIDAD'],
        accentColor: null,
        _count: { exercises: 2 },
      },
      {
        id: 'training-2',
        name: 'Movilidad de hombro',
        type: 'FLEXIBILIDAD',
        types: ['FLEXIBILIDAD'],
        accentColor: null,
        _count: { exercises: 4 },
      },
      {
        id: 'training-3',
        name: 'Cardio expres',
        type: 'CARDIO',
        types: ['CARDIO'],
        accentColor: null,
        _count: { exercises: 1 },
      },
    ]);

    await expect(service.findAll(query)).resolves.toEqual({
      data: [
        {
          id: 'training-2',
          name: 'Movilidad de hombro',
          type: 'FLEXIBILIDAD',
          types: ['FLEXIBILIDAD'],
          accentColor: null,
          exercises_count: 4,
        },
      ],
      total: 2,
      page: 2,
      limit: 1,
      totalPages: 2,
    });

    expect(prisma.training.findMany).toHaveBeenCalledWith({
      where: {
        is_active: true,
        OR: [
          { types: { hasSome: ['FLEXIBILIDAD'] } },
          { type: { in: ['FLEXIBILIDAD'] } },
        ],
      },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      select: expect.objectContaining({
        _count: { select: { exercises: true } },
      }),
    });
    expect(prisma.training.count).not.toHaveBeenCalled();
  });

  it('filters ungrouped trainings and rejects conflicting group filters', async () => {
    const query = Object.assign(new TrainingsQueryDto(), {
      page: 1,
      limit: 20,
      ungrouped: true,
    });
    prisma.training.findMany.mockResolvedValue([]);
    prisma.training.count.mockResolvedValue(0);

    await service.findAll(query);
    expect(prisma.training.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { is_active: true, group_id: null } }),
    );

    await expect(
      service.findAll(
        Object.assign(new TrainingsQueryDto(), {
          page: 1,
          limit: 20,
          group_id: 'group-1',
          ungrouped: true,
        }),
      ),
    ).rejects.toThrow('No se puede combinar group_id con ungrouped');
  });

  it('lists unique training types from active trainings', async () => {
    prisma.training.findMany.mockResolvedValue([
      { type: 'FUERZA', types: ['FUERZA'] },
      { type: 'Pilates', types: ['Pilates', 'Cardio'] },
      { type: 'pilates', types: [] },
      { type: 'HIIT', types: ['HIIT', 'cardio'] },
    ]);
    prisma.catalogColor.findMany.mockResolvedValue([
      { normalized_key: 'fuerza', color: '#3B82F6' },
      { normalized_key: 'hiit', color: '#F97316' },
    ]);

    await expect(service.findAllTypes()).resolves.toEqual({
      types: [
        { value: 'Cardio', color: '#6B7280' },
        { value: 'FUERZA', color: '#3B82F6' },
        { value: 'HIIT', color: '#F97316' },
        { value: 'Pilates', color: '#6B7280' },
      ],
    });
  });

  it('deletes multiple tags from each affected training in one transaction', async () => {
    prisma.training.findMany.mockResolvedValue([
      { id: 'training-1', tags: ['Fuerza', 'Casa', 'Corto'] },
      { id: 'training-2', tags: ['Casa'] },
    ]);
    prisma.training.update.mockImplementation(({ data }) => Promise.resolve(data));

    await expect(service.deleteTags(['fuerza', 'CASA'])).resolves.toEqual({
      values: ['fuerza', 'CASA'],
      affected_count: 2,
    });
    expect(prisma.training.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'training-1' },
      data: { tags: ['Corto'] },
    });
    expect(prisma.training.update).toHaveBeenNthCalledWith(2, {
      where: { id: 'training-2' },
      data: { tags: [] },
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('deletes training types while preserving a remaining type', async () => {
    prisma.training.findMany.mockResolvedValue([
      { id: 'training-1', name: 'Mixto', type: 'Fuerza', types: ['Fuerza', 'Cardio'] },
    ]);
    prisma.achievement.findMany.mockResolvedValue([]);
    prisma.training.update.mockResolvedValue({});

    await expect(service.deleteTypes(['fuerza'])).resolves.toEqual({
      values: ['fuerza'],
      affected_count: 1,
    });
    expect(prisma.training.update).toHaveBeenCalledWith({
      where: { id: 'training-1' },
      data: { types: ['Cardio'], type: 'Cardio' },
    });
  });

  it('blocks deleting a required or achievement-referenced training type', async () => {
    prisma.training.findMany.mockResolvedValue([
      { id: 'training-1', name: 'Fuerza', type: 'Fuerza', types: ['Fuerza'] },
    ]);
    prisma.achievement.findMany.mockResolvedValue([
      { id: 'achievement-1', name: 'Fuerza', rule_config: { training_type: 'Fuerza' } },
    ]);

    await expect(service.deleteTypes(['Fuerza'])).rejects.toThrow(
      'dejaría 1 entrenamiento sin tipo y afectaría 1 logro configurado',
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('renames training types across trainings and achievement rules', async () => {
    prisma.training.findMany.mockResolvedValue([
      { id: 'training-1', type: 'Pilates', types: ['Pilates'] },
      { id: 'training-2', type: 'HIIT', types: ['HIIT', 'Pilates'] },
      { id: 'training-3', type: 'pilates', types: [] },
    ]);
    prisma.achievement.findMany.mockResolvedValue([
      {
        id: 'achievement-1',
        rule_config: { training_type: 'PILATES' },
      },
      {
        id: 'achievement-2',
        rule_config: { training_type: 'HIIT' },
      },
      {
        id: 'achievement-3',
        rule_config: null,
      },
    ]);
    prisma.training.update.mockResolvedValue({});
    prisma.achievement.update.mockResolvedValue({});
    prisma.catalogColor.upsert.mockResolvedValue({});

    await expect(service.renameType('Pilates', 'Movilidad')).resolves.toEqual({
      value: 'Movilidad',
      affected_count: 4,
    });

    expect(prisma.training.update).toHaveBeenCalledTimes(3);
    expect(prisma.training.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'training-1' },
      data: { type: 'Movilidad', types: ['Movilidad'] },
    });
    expect(prisma.training.update).toHaveBeenNthCalledWith(2, {
      where: { id: 'training-2' },
      data: { types: ['HIIT', 'Movilidad'] },
    });
    expect(prisma.training.update).toHaveBeenNthCalledWith(3, {
      where: { id: 'training-3' },
      data: { type: 'Movilidad', types: ['Movilidad'] },
    });
    expect(prisma.achievement.update).toHaveBeenCalledWith({
      where: { id: 'achievement-1' },
      data: {
        rule_config: { training_type: 'Movilidad' },
      },
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.catalogColor.upsert).toHaveBeenCalledWith({
      where: {
        catalog_type_normalized_key: {
          catalog_type: 'training_type',
          normalized_key: 'pilates',
        },
      },
      update: {
        normalized_key: 'movilidad',
        value: 'Movilidad',
      },
      create: {
        catalog_type: 'training_type',
        normalized_key: 'movilidad',
        value: 'Movilidad',
        color: '#6B7280',
      },
    });
    expect(prisma.$transaction.mock.calls[0][0]).toHaveLength(5);
  });

  it('updates training type color with hex validation', async () => {
    prisma.catalogColor.upsert.mockResolvedValue({
      value: 'Pilates',
      color: '#22C55E',
    });

    await expect(service.updateTypeColor('Pilates', '#22c55e')).resolves.toEqual({
      value: 'Pilates',
      color: '#22C55E',
    });

    await expect(service.updateTypeColor('Pilates', 'green')).rejects.toThrow(
      'El color del catálogo debe ser un valor hex #RRGGBB válido',
    );
  });

  it('reconciles before resolving assignment metadata for training detail', async () => {
    const target = new Date('2026-09-03T00:00:00.000Z');
    prisma.training.findFirst.mockResolvedValue({
      id: 'training-1',
      name: 'Fuerza',
      type: 'FUERZA',
      types: ['FUERZA'],
      accentColor: null,
      blocks: [],
      exercises: [],
    });
    prisma.planAssignment.findUnique.mockResolvedValue({
      trainings: [
        { id: 'assignment-training-1', requires_last_set_video: true },
      ],
    });

    await expect(
      service.findOne('training-1', 'client-1', target),
    ).resolves.toEqual(
      expect.objectContaining({
        assignment_training_id: 'assignment-training-1',
        assignment_date: '2026-09-03',
        requires_last_set_video: true,
      }),
    );

    expect(autoAssignmentMaterializer.reconcile).toHaveBeenCalledWith(
      'client-1',
      { start: target, end: target, dates: [target] },
    );
    expect(
      autoAssignmentMaterializer.reconcile.mock.invocationCallOrder[0],
    ).toBeLessThan(
      prisma.planAssignment.findUnique.mock.invocationCallOrder[0],
    );
  });

  it('does not return inactive assigned trainings as the current training', async () => {
    prisma.planAssignment.findUnique.mockResolvedValue({
      trainings: [],
      training: {
        id: 'training-inactive',
        name: 'Retirado',
        type: 'FUERZA',
        types: ['FUERZA'],
        is_active: false,
        blocks: [],
        exercises: [],
      },
    });
    prisma.dayProgress.findUnique.mockResolvedValue(null);

    await expect(
      service.findDay('client-1', new Date('2026-09-03T00:00:00.000Z')),
    ).resolves.toEqual({
      date: '2026-09-03',
      training_completed: false,
      trainings: [],
    });
    expect(prisma.planAssignment.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          trainings: expect.objectContaining({
            where: { training: { is_active: true } },
            orderBy: { position: 'asc' },
          }),
        }),
      }),
    );
    expect(autoAssignmentMaterializer.reconcile).toHaveBeenCalledWith(
      'client-1',
      {
        start: new Date('2026-09-03T00:00:00.000Z'),
        end: new Date('2026-09-03T00:00:00.000Z'),
        dates: [new Date('2026-09-03T00:00:00.000Z')],
      },
    );
  });

  it('does not mark replacement trainings complete from historical progress', async () => {
    const createTraining = (
      id: string,
      trainingExerciseId: string,
      exerciseId: string,
    ) => ({
      id,
      name: id,
      type: 'FUERZA',
      types: ['FUERZA'],
      accentColor: null,
      is_active: true,
      blocks: [],
      exercises: [
        {
          id: trainingExerciseId,
          exercise_id: exerciseId,
          order: 0,
          block_id: null,
          exercise: { id: exerciseId },
        },
      ],
    });
    prisma.planAssignment.findUnique.mockResolvedValue({
      trainings: [
        {
          id: 'assignment-training-new-1',
          requires_last_set_video: false,
          training: createTraining(
            'training-new-1',
            'training-exercise-new-1',
            'exercise-new-1',
          ),
        },
        {
          id: 'assignment-training-new-2',
          requires_last_set_video: false,
          training: createTraining(
            'training-new-2',
            'training-exercise-new-2',
            'exercise-new-2',
          ),
        },
      ],
      training: null,
    });
    prisma.dayProgress.findUnique.mockResolvedValue({
      training_completed: true,
      trainings_completed: ['training-old'],
      exercises_completed: [
        {
          training_exercise_id: 'training-exercise-old',
          exercise_id: 'exercise-old',
        },
      ],
    });

    const result = await service.findDay(
      'client-1',
      new Date('2026-09-03T00:00:00.000Z'),
    );

    expect(result).toMatchObject({
      training_completed: false,
      trainings: [
        { id: 'training-new-1', completed: false },
        { id: 'training-new-2', completed: false },
      ],
    });
    expect(prisma.dayProgress.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ exercises_completed: true }),
      }),
    );
  });
});
