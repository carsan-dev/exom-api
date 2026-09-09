import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { parseDateOnly, formatDateOnly } from '../../common/date-only';
import { ASSIGNMENT_TRANSACTION_OPTIONS } from './assignment-planning-lock';
import { lockClientDayProgress } from '../../common/progress/day-progress-lock';
import { UpdateRirCycleDto } from './dto/rir-cycle.dto';
import { monday, resolveRir, rirWeek, validateRirConfig } from './rir-cycle';

@Injectable()
export class RirCycleService {
  constructor(private readonly prisma: PrismaService) {}

  private async authorize(
    db: Prisma.TransactionClient,
    actor: AuthenticatedUser,
    clientId: string,
  ) {
    const client = await db.user.findUnique({
      where: { id: clientId },
      select: { role: true },
    });
    if (client?.role !== Role.CLIENT)
      throw new NotFoundException('Cliente no encontrado');
    const user = await db.user.findUnique({
      where: { id: actor.id },
      select: { role: true, is_active: true, is_locked: true },
    });
    if (
      !user?.is_active ||
      user.is_locked ||
      (user.role !== Role.ADMIN && user.role !== Role.SUPER_ADMIN)
    )
      throw new ForbiddenException();
    if (user.role === Role.SUPER_ADMIN) return;
    const access = await db.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT id FROM admin_client_assignments WHERE admin_id = ${actor.id} AND client_id = ${clientId} AND is_active = true FOR SHARE`,
    );
    if (!access.length)
      throw new ForbiddenException('Este cliente no está asignado a ti');
  }

  private date(value: string): Date {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
      throw new BadRequestException('Utiliza una fecha YYYY-MM-DD');
    return parseDateOnly(value);
  }

  async read(
    actor: AuthenticatedUser,
    clientId: string,
    from: string,
    to: string,
  ) {
    const start = this.date(from),
      end = this.date(to);
    if (end < start || end.getTime() - start.getTime() > 184 * 86400000)
      throw new BadRequestException('Selecciona hasta seis meses');
    return this.prisma.$transaction(async (db) => {
      await lockClientDayProgress(db, clientId);
      await db.$queryRaw(
        Prisma.sql`SELECT id FROM users WHERE id IN (${clientId}, ${actor.id}) ORDER BY id FOR UPDATE`,
      );
      await this.authorize(db, actor, clientId);
      const versions = await db.rirCycleVersion.findMany({
        where: { client_id: clientId },
        orderBy: { revision: 'desc' },
      });
      const assignments = await db.planAssignment.findMany({
        where: { client_id: clientId, date: { gte: start, lte: end } },
        orderBy: { date: 'asc' },
        include: {
          training: { include: { exercises: { include: { exercise: true } } } },
          trainings: {
            orderBy: { position: 'asc' },
            include: {
              training: {
                include: { exercises: { include: { exercise: true } } },
              },
            },
          },
        },
      });
      const targets = await db.rirDayTarget.findMany({
        where: { client_id: clientId, date: { gte: start, lte: end } },
      });
      const protectedDays = await db.$queryRaw<
        Array<{ date: Date; protected: boolean }>
      >(
        Prisma.sql`SELECT d::date AS date, exom_rir_protected(${clientId}, d::date) AS protected FROM generate_series(${start}::date,${end}::date,interval '1 day') d`,
      );
      const targetIndex = new Map(
        targets.map((t) => [
          `${formatDateOnly(t.date)}:${t.training_exercise_id}`,
          t,
        ]),
      );
      return {
        revision: versions[0]?.revision ?? 0,
        versions: versions.map((v) => ({
          revision: v.revision,
          effective_from: formatDateOnly(v.effective_from),
          starts_on: formatDateOnly(v.starts_on),
          config: v.config,
        })),
        dates: protectedDays.map((d) => {
          const date = formatDateOnly(d.date);
          const assignment = assignments.find(
            (a) => a.date.getTime() === d.date.getTime(),
          );
          const trainings = assignment?.is_rest_day
            ? []
            : assignment?.trainings.length
              ? assignment.trainings.map((l) => l.training)
              : assignment?.training
                ? [assignment.training]
                : [];
          const currentOccurrences = new Set(
            trainings.flatMap((t) => t.exercises.map((e) => e.id)),
          );
          const observed = targets.find(
            (t) =>
              t.date.getTime() === d.date.getTime() &&
              currentOccurrences.has(t.training_exercise_id),
          );
          const version = d.protected
            ? versions.find((v) => v.revision === observed?.revision)
            : versions.find((v) => v.effective_from <= d.date);
          const config = version?.config
            ? validateRirConfig(version.config)
            : null;
          const week =
            config && version
              ? rirWeek(d.date, version.starts_on, config.sequence.length)
              : null;
          return {
            date,
            protected: d.protected,
            week: week === null ? null : week + 1,
            weeks: config?.sequence.length ?? null,
            target_rir: week === null ? null : config!.sequence[week],
            trainings: trainings.map((t) => ({
              id: t.id,
              name: t.name,
              rir_proposal: t.rir_proposal,
              exercises: t.exercises.map((e) => {
                const saved = targetIndex.get(`${date}:${e.id}`);
                return {
                  id: e.id,
                  name: e.exercise.name,
                  block_id: e.block_id,
                  base_rir: e.target_rir,
                  rir_override: e.rir_override,
                  target_rir: saved
                    ? saved.target_rir
                    : d.protected
                      ? e.target_rir
                      : resolveRir(
                          config,
                          version?.starts_on ?? d.date,
                          d.date,
                          e.id,
                          e.target_rir,
                        ),
                  provenance: saved
                    ? 'observed'
                    : d.protected
                      ? 'legacy_unrecorded'
                      : 'preview',
                };
              }),
            })),
          };
        }),
      };
    }, ASSIGNMENT_TRANSACTION_OPTIONS);
  }

  async update(
    actor: AuthenticatedUser,
    clientId: string,
    dto: UpdateRirCycleDto,
  ) {
    const effective = this.date(dto.effective_from);
    const config = dto.config === null ? null : validateRirConfig(dto.config);
    const request = {
      effective_from: dto.effective_from,
      starts_on: dto.starts_on ?? null,
      expected_revision: dto.expected_revision,
      config: config ? { ...config } : null,
    };
    return this.prisma.$transaction(async (db) => {
      await lockClientDayProgress(db, clientId);
      await db.$queryRaw(
        Prisma.sql`SELECT id FROM users WHERE id IN (${clientId}, ${actor.id}) ORDER BY id FOR UPDATE`,
      );
      await this.authorize(db, actor, clientId);
      const previousOperation = await db.rirCycleVersion.findUnique({
        where: {
          client_id_operation_id: {
            client_id: clientId,
            operation_id: dto.operation_id,
          },
        },
      });
      if (previousOperation) {
        // PostgreSQL JSONB equality ignores object key ordering in a retried payload.
        const same = await db.$queryRaw<Array<{ same: boolean }>>(
          Prisma.sql`SELECT request = ${JSON.stringify(request)}::jsonb AS same FROM rir_cycle_versions WHERE client_id = ${clientId} AND operation_id = ${dto.operation_id}`,
        );
        if (!same[0]?.same)
          throw new ConflictException(
            'La identidad de operación ya se utilizó con otro cambio',
          );
        return { revision: previousOperation.revision };
      }
      const latest = await db.rirCycleVersion.findFirst({
        where: { client_id: clientId },
        orderBy: { revision: 'desc' },
      });
      if ((latest?.revision ?? 0) !== dto.expected_revision)
        throw new ConflictException(
          'El mesociclo ha cambiado. Actualiza la vista antes de editar',
        );
      const protectedDate = await db.$queryRaw<Array<{ protected: boolean }>>(
        Prisma.sql`SELECT exom_rir_protected(${clientId},${effective}::date) AS protected`,
      );
      if (protectedDate[0]?.protected)
        throw new ConflictException(
          'La fecha de aplicación está en el pasado o ya tiene progreso',
        );
      const starts = dto.starts_on
        ? monday(this.date(dto.starts_on))
        : (latest?.starts_on ?? monday(effective));
      if (config) {
        const ids = Object.keys(config.overrides);
        const exercises = await db.trainingExercise.findMany({
          where: { id: { in: ids } },
          select: { id: true },
        });
        // A stale occurrence can stay attached to its old ID, but cannot be introduced anew.
        const existing = latest?.config
          ? validateRirConfig(latest.config).overrides
          : {};
        if (
          ids.some(
            (id) => !exercises.some((e) => e.id === id) && !(id in existing),
          )
        )
          throw new BadRequestException(
            'Una excepción referencia un ejercicio eliminado o inexistente',
          );
      }
      const saved = await db.rirCycleVersion.create({
        data: {
          client_id: clientId,
          revision: dto.expected_revision + 1,
          operation_id: dto.operation_id,
          request,
          effective_from: effective,
          starts_on: starts,
          config: config
            ? { sequence: config.sequence, overrides: { ...config.overrides } }
            : Prisma.DbNull,
        },
      });
      return { revision: saved.revision };
    }, ASSIGNMENT_TRANSACTION_OPTIONS);
  }
}
