import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { formatDateOnly, parseDateOnly } from '../../common/date-only';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateAdherenceConfigDto } from './dto/adherence-config.dto';

const UPDATE_TRANSACTION_TIMEOUT_MS = 30_000;
const MIDNIGHT_SAFETY_MARGIN_MS = 1_000;

const DEFAULTS = {
  steps_goal: null,
  calorie_lower_percent: 10,
  calorie_upper_percent: 10,
  protein_min_percent: 90,
  steps_min_percent: 100,
  low_global_percent: 80,
} as const;

@Injectable()
export class AdherenceConfigService {
  constructor(private readonly prisma: PrismaService) {}

  protected utcInstant(): Date {
    return new Date();
  }

  private async assertWriteAccess(
    tx: Prisma.TransactionClient,
    actorId: string,
    role: string,
    clientId: string,
  ) {
    if (role !== Role.ADMIN && role !== Role.SUPER_ADMIN) {
      throw new ForbiddenException('Admin access required');
    }
    const client = await tx.user.findUnique({
      where: { id: clientId },
      select: { role: true },
    });
    if (client?.role !== Role.CLIENT)
      throw new NotFoundException('Client not found');
    if (role === Role.ADMIN) {
      // The revocation writer updates this same assignment row. FOR UPDATE
      // holds it through commit, so revocation cannot overtake this write.
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "admin_client_assignments"
        WHERE "admin_id" = ${actorId} AND "client_id" = ${clientId}
          AND "is_active" = true FOR UPDATE
      `;
      if (rows.length === 0)
        throw new ForbiddenException('Client not assigned');
    }
  }

  async get(actorId: string, role: string, clientId: string, date?: string) {
    const today = formatDateOnly(new Date());
    const selected = date ?? today;
    const at = parseDateOnly(selected);
    let result: {
      head: Prisma.AdherenceConfigHeadGetPayload<object> | null;
      epoch: Prisma.AdherenceConfigEpochGetPayload<object> | null;
      revision: Prisma.AdherenceConfigRevisionGetPayload<object> | null;
    };
    try {
      result = await this.prisma.$transaction(
        async (tx) => {
          await this.assertWriteAccess(tx, actorId, role, clientId);
          const head = await tx.adherenceConfigHead.findUnique({
            where: { client_id: clientId },
          });
          const epoch = await tx.adherenceConfigEpoch.findUnique({
            where: { id: 'default' },
          });
          const revision = await tx.adherenceConfigRevision.findFirst({
            where: { client_id: clientId, effective_date: { lte: at } },
            orderBy: { effective_date: 'desc' },
          });
          return { head, epoch, revision };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      );
    } catch (error) {
      const adapter =
        error instanceof Prisma.PrismaClientKnownRequestError
          ? error.meta?.driverAdapterError
          : null;
      const cause =
        adapter && typeof adapter === 'object' && 'cause' in adapter
          ? adapter.cause
          : null;
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === 'P2034' ||
          (error.code === 'P2010' &&
            cause &&
            typeof cause === 'object' &&
            'originalCode' in cause &&
            cause.originalCode === '40001'))
      )
        throw new ConflictException(
          'Access changed concurrently; refresh and retry',
        );
      throw error;
    }
    const version = result.head?.version ?? 0;
    if (result.revision) {
      const { revision } = result;
      return {
        version,
        known: true,
        source: 'revision',
        effective_date: formatDateOnly(revision.effective_date),
        steps_goal: revision.steps_goal,
        calorie_lower_percent: revision.calorie_lower_percent,
        calorie_upper_percent: revision.calorie_upper_percent,
        protein_min_percent: revision.protein_min_percent,
        steps_min_percent: revision.steps_min_percent,
        low_global_percent: revision.low_global_percent,
      };
    }
    // Defaults are a present-day policy, not evidence about pre-capture days.
    if (result.epoch && selected >= formatDateOnly(result.epoch.effective_date))
      return {
        version,
        known: true,
        source: 'default',
        effective_date: null,
        ...DEFAULTS,
      };
    return {
      version,
      known: false,
      source: 'uncaptured',
      effective_date: null,
    };
  }

  async update(
    actorId: string,
    role: string,
    clientId: string,
    dto: UpdateAdherenceConfigDto,
  ) {
    if (dto.steps_goal === undefined)
      throw new BadRequestException('steps_goal is required (nullable)');
    const today = formatDateOnly(this.utcInstant());
    const effectiveDate = parseDateOnly(dto.effective_date, 'effective_date');
    if (dto.effective_date <= today) {
      throw new ConflictException(
        'Only future dates can be configured; closed days cannot be revised',
      );
    }
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          await this.assertWriteAccess(tx, actorId, role, clientId);
          const head = await tx.adherenceConfigHead.findUnique({
            where: { client_id: clientId },
          });
          if ((head?.version ?? 0) !== dto.expected_version) {
            throw new ConflictException(
              'Configuration version changed; refresh and retry',
            );
          }
          const latest = await tx.adherenceConfigRevision.findFirst({
            where: { client_id: clientId },
            orderBy: { effective_date: 'desc' },
            select: { effective_date: true },
          });
          if (latest && latest.effective_date >= effectiveDate) {
            throw new ConflictException(
              'New revision must follow all scheduled revisions',
            );
          }
          const version = dto.expected_version + 1;
          if (!head) {
            await tx.adherenceConfigHead.create({
              data: { client_id: clientId, version },
            });
          } else {
            const updated = await tx.adherenceConfigHead.updateMany({
              where: { client_id: clientId, version: dto.expected_version },
              data: { version },
            });
            if (updated.count !== 1)
              throw new ConflictException(
                'Configuration version changed; refresh and retry',
              );
          }
          // The transaction can remain open after this check. When its
          // timeout horizon crosses midnight, tomorrow is not safe yet;
          // equality is allowed only for a provisional today after midnight.
          const now = this.utcInstant();
          const safeThrough = formatDateOnly(
            new Date(
              now.getTime() +
                UPDATE_TRANSACTION_TIMEOUT_MS +
                MIDNIGHT_SAFETY_MARGIN_MS,
            ),
          );
          if (
            dto.effective_date < safeThrough ||
            (dto.effective_date === safeThrough &&
              formatDateOnly(now) < safeThrough)
          ) {
            throw new ConflictException('Effective date is already closed');
          }
          const revision = await tx.adherenceConfigRevision.create({
            data: {
              client_id: clientId,
              version,
              effective_date: effectiveDate,
              steps_goal: dto.steps_goal,
              calorie_lower_percent: dto.calorie_lower_percent,
              calorie_upper_percent: dto.calorie_upper_percent,
              protein_min_percent: dto.protein_min_percent,
              steps_min_percent: dto.steps_min_percent,
              low_global_percent: dto.low_global_percent,
            },
          });
          return {
            version,
            known: true,
            source: 'revision',
            effective_date: formatDateOnly(revision.effective_date),
            steps_goal: revision.steps_goal,
            calorie_lower_percent: revision.calorie_lower_percent,
            calorie_upper_percent: revision.calorie_upper_percent,
            protein_min_percent: revision.protein_min_percent,
            steps_min_percent: revision.steps_min_percent,
            low_global_percent: revision.low_global_percent,
          };
        },
        { timeout: UPDATE_TRANSACTION_TIMEOUT_MS },
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === 'P2002' || error.code === 'P2034')
      ) {
        throw new ConflictException(
          'Configuration changed concurrently; refresh and retry',
        );
      }
      throw error;
    }
  }
}
