import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AssignmentsService } from './assignments.service';

function createAssignment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'assignment-1',
    client_id: 'client-1',
    admin_id: 'admin-1',
    date: new Date('2026-03-30T00:00:00.000Z'),
    training_id: 'training-1',
    diet_id: null,
    is_rest_day: false,
    training: {
      id: 'training-1',
      name: 'Full Body A',
      type: 'FUERZA',
      level: 'INTERMEDIO',
      estimated_duration_min: 45,
      estimated_calories: 320,
    },
    diet: null,
    ...overrides,
  };
}

describe('AssignmentsService', () => {
  let service: AssignmentsService;
  let prisma: {
    user: { findUnique: jest.Mock };
    adminClientAssignment: { findFirst: jest.Mock };
    training: { findFirst: jest.Mock };
    diet: { findFirst: jest.Mock };
    planAssignment: {
      upsert: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
      deleteMany: jest.Mock;
    };
    $transaction: jest.Mock;
  };

  const adminUser = {
    id: 'admin-1',
    email: 'admin@exom.dev',
    role: Role.ADMIN,
    firebase_uid: 'firebase-admin-1',
  };

  const superAdminUser = {
    id: 'super-admin-1',
    email: 'superadmin@exom.dev',
    role: Role.SUPER_ADMIN,
    firebase_uid: 'firebase-super-admin-1',
  };

  const clientUser = {
    id: 'client-1',
    email: 'client@exom.dev',
    role: Role.CLIENT,
    firebase_uid: 'firebase-client-1',
  };

  beforeEach(() => {
    prisma = {
      user: {
        findUnique: jest.fn(),
      },
      adminClientAssignment: {
        findFirst: jest.fn(),
      },
      training: {
        findFirst: jest.fn(),
      },
      diet: {
        findFirst: jest.fn(),
      },
      planAssignment: {
        upsert: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        deleteMany: jest.fn(),
      },
      $transaction: jest.fn(async (operations: Promise<unknown>[]) =>
        Promise.all(operations),
      ),
    };

    service = new AssignmentsService(prisma as unknown as PrismaService);
  });

  it('rejects bulk assignment when no training, diet or rest day is provided', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'client-1', role: Role.CLIENT });
    prisma.adminClientAssignment.findFirst.mockResolvedValue({ id: 'link-1' });

    await expect(
      service.bulkAssign(adminUser, {
        client_id: 'client-1',
        dates: ['2026-03-30'],
      }),
    ).rejects.toThrow(
      new BadRequestException(
        'Debes asignar un entrenamiento, una dieta o marcar descanso',
      ),
    );

    expect(prisma.training.findFirst).not.toHaveBeenCalled();
    expect(prisma.diet.findFirst).not.toHaveBeenCalled();
    expect(prisma.planAssignment.upsert).not.toHaveBeenCalled();
  });

  it('allows a super admin to bulk-assign without admin-client relation', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'client-1', role: Role.CLIENT });
    prisma.training.findFirst.mockResolvedValue({ id: 'training-1' });
    prisma.planAssignment.upsert.mockResolvedValue(createAssignment());

    await expect(
      service.bulkAssign(superAdminUser, {
        client_id: 'client-1',
        dates: ['2026-03-30'],
        training_id: 'training-1',
      }),
    ).resolves.toEqual([
      {
        id: 'assignment-1',
        client_id: 'client-1',
        date: '2026-03-30',
        is_rest_day: false,
        training: createAssignment().training,
        diet: null,
      },
    ]);

    expect(prisma.adminClientAssignment.findFirst).not.toHaveBeenCalled();
    expect(prisma.planAssignment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ admin_id: 'super-admin-1' }),
        update: expect.objectContaining({ admin_id: 'super-admin-1' }),
      }),
    );
  });

  it('rejects getWeek for an admin when the client is not assigned', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'client-1', role: Role.CLIENT });
    prisma.adminClientAssignment.findFirst.mockResolvedValue(null);

    await expect(
      service.getWeek(adminUser, {
        client_id: 'client-1',
        week_start: '2026-03-30',
      }),
    ).rejects.toThrow(new ForbiddenException('Este cliente no está asignado a ti'));

    expect(prisma.planAssignment.findMany).not.toHaveBeenCalled();
  });

  it('returns a normalized 7-day response for the client weekly view', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'client-1', role: Role.CLIENT });
    prisma.planAssignment.findMany.mockResolvedValue([createAssignment()]);

    const response = await service.getWeek(clientUser, {
      client_id: 'client-1',
      week_start: '2026-03-30',
    });

    expect(response.week_start).toBe('2026-03-30');
    expect(response.week_end).toBe('2026-04-05');
    expect(response.days).toHaveLength(7);
    expect(response.days[0]).toEqual({
      id: 'assignment-1',
      client_id: 'client-1',
      date: '2026-03-30',
      is_rest_day: false,
      training: createAssignment().training,
      diet: null,
    });
    expect(response.days[1]).toEqual({
      id: null,
      client_id: 'client-1',
      date: '2026-03-31',
      is_rest_day: false,
      training: null,
      diet: null,
    });
    expect(prisma.adminClientAssignment.findFirst).not.toHaveBeenCalled();
  });

  it('returns a normalized monthly response for admin planning', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'client-1', role: Role.CLIENT });
    prisma.adminClientAssignment.findFirst.mockResolvedValue({ id: 'link-1' });
    prisma.planAssignment.findMany.mockResolvedValue([
      createAssignment(),
      createAssignment({
        id: 'assignment-2',
        date: new Date('2026-03-31T00:00:00.000Z'),
        training_id: null,
        diet_id: 'diet-1',
        is_rest_day: false,
        training: null,
        diet: {
          id: 'diet-1',
          name: 'Dieta Marzo',
          total_calories: 2100,
          total_protein_g: 160,
          total_carbs_g: 220,
          total_fat_g: 70,
        },
      }),
    ]);

    const response = await service.getMonth(adminUser, {
      client_id: 'client-1',
      year: 2026,
      month: 3,
    });

    expect(response.month_start).toBe('2026-03-01');
    expect(response.month_end).toBe('2026-03-31');
    expect(response.days).toHaveLength(31);
    expect(response.days[29]).toEqual({
      id: 'assignment-1',
      client_id: 'client-1',
      date: '2026-03-30',
      is_rest_day: false,
      training: createAssignment().training,
      diet: null,
    });
    expect(response.days[30]).toEqual({
      id: 'assignment-2',
      client_id: 'client-1',
      date: '2026-03-31',
      is_rest_day: false,
      training: null,
      diet: {
        id: 'diet-1',
        name: 'Dieta Marzo',
        total_calories: 2100,
        total_protein_g: 160,
        total_carbs_g: 220,
        total_fat_g: 70,
      },
    });
  });

  it('batch assigns unique days with per-day combinations', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'client-1', role: Role.CLIENT });
    prisma.adminClientAssignment.findFirst.mockResolvedValue({ id: 'link-1' });
    prisma.diet.findFirst.mockResolvedValue({ id: 'diet-1' });
    prisma.planAssignment.upsert
      .mockResolvedValueOnce(
        createAssignment({
          id: 'assignment-rest',
          date: new Date('2026-03-31T00:00:00.000Z'),
          training_id: null,
          diet_id: null,
          is_rest_day: true,
          training: null,
          diet: null,
        }),
      )
      .mockResolvedValueOnce(
        createAssignment({
          id: 'assignment-diet',
          date: new Date('2026-04-01T00:00:00.000Z'),
          training_id: null,
          diet_id: 'diet-1',
          is_rest_day: false,
          training: null,
          diet: {
            id: 'diet-1',
            name: 'Dieta Abril',
            total_calories: 1900,
            total_protein_g: 150,
            total_carbs_g: 200,
            total_fat_g: 60,
          },
        }),
      );

    await expect(
      service.batchAssign(adminUser, {
        client_id: 'client-1',
        days: [
          { date: '2026-04-01', diet_id: 'diet-1', is_rest_day: false },
          { date: '2026-03-31', training_id: 'training-1', is_rest_day: false },
          { date: '2026-03-31', is_rest_day: true },
        ],
      }),
    ).resolves.toEqual([
      {
        id: 'assignment-rest',
        client_id: 'client-1',
        date: '2026-03-31',
        is_rest_day: true,
        training: null,
        diet: null,
      },
      {
        id: 'assignment-diet',
        client_id: 'client-1',
        date: '2026-04-01',
        is_rest_day: false,
        training: null,
        diet: {
          id: 'diet-1',
          name: 'Dieta Abril',
          total_calories: 1900,
          total_protein_g: 150,
          total_carbs_g: 200,
          total_fat_g: 60,
        },
      },
    ]);

    expect(prisma.planAssignment.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.planAssignment.upsert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        create: expect.objectContaining({
          date: new Date('2026-03-31T00:00:00.000Z'),
          training_id: null,
          diet_id: null,
          is_rest_day: true,
        }),
      }),
    );
  });

  it('rejects copyWeek when source and target weeks are the same', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'client-1', role: Role.CLIENT });
    prisma.adminClientAssignment.findFirst.mockResolvedValue({ id: 'link-1' });

    await expect(
      service.copyWeek(adminUser, {
        client_id: 'client-1',
        source_week_start: '2026-03-30',
        target_week_start: '2026-03-30',
      }),
    ).rejects.toThrow(
      new BadRequestException('La semana de origen y destino no puede ser la misma'),
    );

    expect(prisma.planAssignment.findMany).not.toHaveBeenCalled();
  });

  it('rejects update when moving an assignment to a date already occupied', async () => {
    prisma.planAssignment.findUnique
      .mockResolvedValueOnce(createAssignment())
      .mockResolvedValueOnce({ id: 'assignment-2' });
    prisma.user.findUnique.mockResolvedValue({ id: 'client-1', role: Role.CLIENT });
    prisma.adminClientAssignment.findFirst.mockResolvedValue({ id: 'link-1' });

    await expect(
      service.updateAssignment(adminUser, 'assignment-1', {
        date: '2026-03-31',
        training_id: 'training-1',
      }),
    ).rejects.toThrow(
      new ConflictException(
        'Ya existe una asignación para ese cliente en la fecha indicada',
      ),
    );

    expect(prisma.planAssignment.update).not.toHaveBeenCalled();
  });

  it('deletes a single assignment day after validating access', async () => {
    prisma.planAssignment.findUnique.mockResolvedValue({
      id: 'assignment-1',
      client_id: 'client-1',
    });
    prisma.user.findUnique.mockResolvedValue({ id: 'client-1', role: Role.CLIENT });
    prisma.adminClientAssignment.findFirst.mockResolvedValue({ id: 'link-1' });
    prisma.planAssignment.delete.mockResolvedValue(undefined);

    await expect(
      service.deleteAssignment(adminUser, 'assignment-1'),
    ).resolves.toEqual({
      message: 'Asignación eliminada exitosamente',
    });

    expect(prisma.planAssignment.delete).toHaveBeenCalledWith({
      where: { id: 'assignment-1' },
    });
  });
});
