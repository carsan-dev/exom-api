import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { BaseDeliveryStatus, BaseServiceScope, Prisma } from '@prisma/client';
import { allOf, searchPredicate } from '../../common/query-page';
import { PrismaService } from '../../prisma/prisma.service';
import {
  assertRouteExists,
  BASE_WRITE_TX,
  BaseServiceActor,
  isUniqueViolation,
  lockStaffActor,
  lockSubscriberSendBarrier,
} from './base-service.access';
import { BaseServiceError } from './base-service.error';
import {
  effectiveDeliveryStatusSql,
  parseDeliveryStatus,
} from './base-delivery-state';
import { baseHttp, mapSourceError } from './base-service.http-errors';
import {
  assertSubscriberStampFits,
  normalizeClientName,
  normalizeSubscriberEmail,
} from './base-delivery-input';
import { BaseRoute, listRoutes } from './base-package-selection';
import { BasePdfSourceProvider } from './base-pdf-source.provider';
import type {
  BaseSubscriberFieldsDto,
  CreateBaseSubscriberDto,
  ListBaseSubscribersDto,
} from './dto/base-service.dto';
import { GOAL_PATTERN } from './dto/base-service.dto';

export interface BaseLatestDelivery {
  id: string;
  month: number;
  /** Effective status (an unrecorded send failure reads FAILED). */
  status: BaseDeliveryStatus;
  send_seq: number;
}

export interface BaseSubscriberView {
  id: string;
  order_code: string;
  name: string;
  email: string;
  goal: string;
  days_per_week: number;
  /** What the subscriber contracted; applies to deliveries requested from now on. */
  service_scope: BaseServiceScope;
  notes: string | null;
  is_archived: boolean;
  archived_at: Date | null;
  created_by_id: string | null;
  created_at: Date;
  updated_at: Date;
  /** Highest month that was accepted by the email provider at least once. */
  last_sent_month: number | null;
  /** The only month POST .../deliveries accepts next. */
  next_month: number;
  latest_delivery: BaseLatestDelivery | null;
}

export interface BaseSubscriberPage {
  data: BaseSubscriberView[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

interface SubscriberRow {
  id: string;
  order_code: string;
  name: string;
  email: string;
  goal: string;
  days_per_week: number;
  service_scope: string;
  notes: string | null;
  is_archived: boolean;
  archived_at: Date | null;
  created_by_id: string | null;
  created_at: Date;
  updated_at: Date;
  last_sent_month: number | null;
  next_month: number;
  latest_id: string | null;
  latest_month: number | null;
  latest_status: string | null;
  latest_send_seq: number | null;
}

const projection = Prisma.sql`
  SELECT s.id, s.order_code, s.name, s.email, s.goal, s.days_per_week,
    s.service_scope::text AS service_scope, s.notes,
    s.is_archived, s.archived_at, s.created_by_id, s.created_at, s.updated_at,
    agg.last_sent_month, COALESCE(agg.max_month, 0) + 1 AS next_month,
    latest.id AS latest_id, latest.month AS latest_month,
    latest.status AS latest_status, latest.send_seq AS latest_send_seq
  FROM base_subscribers s
  LEFT JOIN LATERAL (
    SELECT max(d.month) FILTER (WHERE d.sent_at IS NOT NULL) AS last_sent_month,
      max(d.month) AS max_month
    FROM base_deliveries d WHERE d.subscriber_id = s.id
  ) agg ON true
  LEFT JOIN LATERAL (
    SELECT d.id, d.month, ${effectiveDeliveryStatusSql} AS status, d.send_seq
    FROM base_deliveries d
    WHERE d.subscriber_id = s.id ORDER BY d.month DESC LIMIT 1
  ) latest ON true`;

function latestStatus(value: string): BaseDeliveryStatus {
  const status = parseDeliveryStatus(value);
  if (!status)
    throw new InternalServerErrorException('BASE_DELIVERY_STATUS_INVALID');
  return status;
}

const SERVICE_SCOPES: readonly BaseServiceScope[] =
  Object.values(BaseServiceScope);

export function parseServiceScope(value: string): BaseServiceScope | null {
  return SERVICE_SCOPES.find((scope) => scope === value) ?? null;
}

function serviceScope(value: string): BaseServiceScope {
  const scope = parseServiceScope(value);
  if (!scope)
    throw new InternalServerErrorException('BASE_SERVICE_SCOPE_INVALID');
  return scope;
}

function toView(row: SubscriberRow): BaseSubscriberView {
  return {
    id: row.id,
    order_code: row.order_code,
    name: row.name,
    email: row.email,
    goal: row.goal,
    days_per_week: row.days_per_week,
    service_scope: serviceScope(row.service_scope),
    notes: row.notes,
    is_archived: row.is_archived,
    archived_at: row.archived_at,
    created_by_id: row.created_by_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_sent_month: row.last_sent_month,
    next_month: row.next_month,
    latest_delivery:
      row.latest_id !== null &&
      row.latest_month !== null &&
      row.latest_status !== null &&
      row.latest_send_seq !== null
        ? {
            id: row.latest_id,
            month: row.latest_month,
            status: latestStatus(row.latest_status),
            send_seq: row.latest_send_seq,
          }
        : null,
  };
}

const emailTaken = () =>
  baseHttp.conflict(
    'EMAIL_TAKEN',
    'Ya hay un suscriptor activo con ese email. Archívalo o usa otro email.',
  );

export const subscriberNotFound = () =>
  baseHttp.notFound('SUBSCRIBER_NOT_FOUND', 'Suscriptor no encontrado.');

interface NormalizedFields {
  name?: string;
  email?: string;
  goal?: string;
  days_per_week?: number;
  service_scope?: BaseServiceScope;
  notes?: string | null;
}

@Injectable()
export class BaseSubscribersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sources: BasePdfSourceProvider,
  ) {}

  /** Routes offered by the configured catalogue (goal, days, months). */
  async routes(): Promise<BaseRoute[]> {
    try {
      return listRoutes(await this.sources.source().list());
    } catch (error) {
      throw mapSourceError(error, 'subscriber');
    }
  }

  async list(query: ListBaseSubscribersDto): Promise<BaseSubscriberPage> {
    const archive = query.archive ?? 'visible';
    const where = allOf([
      archive === 'all'
        ? Prisma.sql`TRUE`
        : Prisma.sql`s.is_archived = ${archive === 'archived'}`,
      searchPredicate(
        Prisma.sql`concat_ws(' ', s.name, s.email, s.order_code)`,
        query.q,
      ),
    ]);
    const offset = (query.page - 1) * query.limit;
    return this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<SubscriberRow[]>(Prisma.sql`
          ${projection} WHERE ${where}
          ORDER BY s.created_at DESC, s.id DESC OFFSET ${offset} LIMIT ${query.limit}`);
        const [{ total }] = await tx.$queryRaw<{ total: bigint }[]>(
          Prisma.sql`SELECT count(*) AS total FROM base_subscribers s WHERE ${where}`,
        );
        const count = Number(total);
        return {
          data: rows.map(toView),
          total: count,
          page: query.page,
          limit: query.limit,
          totalPages: Math.ceil(count / query.limit),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async get(id: string): Promise<BaseSubscriberView> {
    const [row] = await this.prisma.$queryRaw<SubscriberRow[]>(
      Prisma.sql`${projection} WHERE s.id = ${id}`,
    );
    if (!row) throw subscriberNotFound();
    return toView(row);
  }

  private normalize(input: BaseSubscriberFieldsDto): NormalizedFields {
    const fields: NormalizedFields = {};
    if (input.name !== undefined) {
      try {
        // Stored normalised, so stamping can never reject it later.
        fields.name = normalizeClientName(input.name);
      } catch (error) {
        if (error instanceof BaseServiceError)
          throw baseHttp.badRequest(error.code, error.message);
        throw error;
      }
    }
    if (input.email !== undefined) {
      try {
        // Also printed on every page: must be drawable by the stamp font.
        fields.email = normalizeSubscriberEmail(input.email);
      } catch (error) {
        if (error instanceof BaseServiceError)
          throw baseHttp.badRequest(error.code, error.message);
        throw error;
      }
    }
    if (input.goal !== undefined) {
      if (!GOAL_PATTERN.test(input.goal) || input.goal.length > 64)
        throw baseHttp.badRequest('INVALID_GOAL', 'Objetivo no válido.');
      fields.goal = input.goal;
    }
    if (input.days_per_week !== undefined) {
      if (
        !Number.isInteger(input.days_per_week) ||
        input.days_per_week < 1 ||
        input.days_per_week > 7
      )
        throw baseHttp.badRequest(
          'INVALID_DAYS',
          'Los días por semana deben estar entre 1 y 7.',
        );
      fields.days_per_week = input.days_per_week;
    }
    if (input.service_scope !== undefined) {
      const scope = parseServiceScope(input.service_scope);
      if (!scope)
        throw baseHttp.badRequest(
          'INVALID_SERVICE_SCOPE',
          'Lo contratado debe ser TRAINING, NUTRITION o BOTH.',
        );
      fields.service_scope = scope;
    }
    if (input.notes !== undefined) {
      const notes =
        input.notes === null
          ? null
          : input.notes.replace(/\r\n?/g, '\n').trim() || null;
      if (notes !== null && notes.length > 2000)
        throw baseHttp.badRequest(
          'INVALID_NOTES',
          'Las notas superan los 2000 caracteres.',
        );
      fields.notes = notes;
    }
    return fields;
  }

  /**
   * Name and email are printed together on every PDF page: after their own
   * normalisation, the pair must fit the license line (400 STAMP_TOO_LONG).
   */
  private assertStampFits(name: string, email: string): void {
    try {
      assertSubscriberStampFits(name, email);
    } catch (error) {
      if (error instanceof BaseServiceError)
        throw baseHttp.badRequest(error.code, error.message);
      throw error;
    }
  }

  /** The catalogue must offer the route; read before any transaction. */
  private async assertRoute(goal: string, days: number): Promise<void> {
    try {
      assertRouteExists(await this.sources.source().list(), goal, days);
    } catch (error) {
      throw mapSourceError(error, 'subscriber');
    }
  }

  async create(
    input: CreateBaseSubscriberDto,
    actor: BaseServiceActor,
  ): Promise<BaseSubscriberView> {
    const fields = this.normalize(input);
    if (
      fields.name === undefined ||
      fields.email === undefined ||
      fields.goal === undefined ||
      fields.days_per_week === undefined
    )
      throw baseHttp.badRequest(
        'MISSING_FIELDS',
        'Nombre, email, objetivo y días por semana son obligatorios.',
      );
    const { name, email, goal, days_per_week } = fields;
    this.assertStampFits(name, email);
    await this.assertRoute(goal, days_per_week);
    let id: string;
    try {
      id = await this.prisma.$transaction(async (tx) => {
        await lockStaffActor(tx, actor);
        await this.assertEmailFree(tx, email);
        const created = await tx.baseSubscriber.create({
          // order_code, archive state and timestamps are server-owned.
          data: {
            name,
            email,
            goal,
            days_per_week,
            // Older admin builds send no scope: everything, as before.
            service_scope: fields.service_scope ?? BaseServiceScope.BOTH,
            notes: fields.notes ?? null,
            created_by_id: actor.id,
          },
          select: { id: true },
        });
        return created.id;
      }, BASE_WRITE_TX);
    } catch (error) {
      if (isUniqueViolation(error)) throw emailTaken();
      throw error;
    }
    return this.get(id);
  }

  private async assertEmailFree(
    tx: Prisma.TransactionClient,
    email: string,
    exceptId?: string,
  ): Promise<void> {
    const [clash] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM base_subscribers
      WHERE lower(email) = ${email} AND NOT is_archived
        AND id IS DISTINCT FROM ${exceptId ?? null}
      LIMIT 1`;
    // The partial unique index is the race-free backstop (P2002).
    if (clash) throw emailTaken();
  }

  /** Changes apply to future deliveries only; snapshots stay untouched. */
  async update(
    id: string,
    input: BaseSubscriberFieldsDto,
    actor: BaseServiceActor,
  ): Promise<BaseSubscriberView> {
    const fields = this.normalize(input);
    if (Object.keys(fields).length === 0)
      throw baseHttp.badRequest('NO_CHANGES', 'No hay cambios que guardar.');
    const routeChanges =
      fields.goal !== undefined || fields.days_per_week !== undefined;
    let checkedRoute: { goal: string; days: number } | undefined;
    if (routeChanges) {
      // Catalogue I/O stays outside the transaction and its row locks.
      const current = await this.prisma.baseSubscriber.findUnique({
        where: { id },
        select: { goal: true, days_per_week: true },
      });
      if (!current) throw subscriberNotFound();
      checkedRoute = {
        goal: fields.goal ?? current.goal,
        days: fields.days_per_week ?? current.days_per_week,
      };
      await this.assertRoute(checkedRoute.goal, checkedRoute.days);
    }
    try {
      await this.prisma.$transaction(async (tx) => {
        await lockStaffActor(tx, actor);
        const [row] = await tx.$queryRaw<
          {
            name: string;
            email: string;
            goal: string;
            days_per_week: number;
            is_archived: boolean;
          }[]
        >`SELECT name, email, goal, days_per_week, is_archived FROM base_subscribers WHERE id = ${id} FOR UPDATE`;
        if (!row) throw subscriberNotFound();
        // A one-sided edit is checked against the other half as locked here.
        if (fields.name !== undefined || fields.email !== undefined)
          this.assertStampFits(
            fields.name ?? row.name,
            fields.email ?? row.email,
          );
        // A partial route edit was validated against the values read before
        // the lock; if the other half changed meanwhile, ask for a reload.
        if (
          checkedRoute &&
          (checkedRoute.goal !== (fields.goal ?? row.goal) ||
            checkedRoute.days !== (fields.days_per_week ?? row.days_per_week))
        )
          throw baseHttp.conflict(
            'SUBSCRIBER_CHANGED',
            'El suscriptor ha cambiado mientras guardabas. Recarga y vuelve a intentarlo.',
          );
        if (fields.email !== undefined && !row.is_archived)
          await this.assertEmailFree(tx, fields.email, id);
        await tx.baseSubscriber.update({ where: { id }, data: fields });
      }, BASE_WRITE_TX);
    } catch (error) {
      if (isUniqueViolation(error)) throw emailTaken();
      throw error;
    }
    return this.get(id);
  }

  async setArchived(
    id: string,
    archived: boolean,
    actor: BaseServiceActor,
  ): Promise<BaseSubscriberView> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await lockStaffActor(tx, actor);
        const [row] = await tx.$queryRaw<
          { email: string; is_archived: boolean }[]
        >`SELECT email, is_archived FROM base_subscribers WHERE id = ${id} FOR UPDATE`;
        if (!row) throw subscriberNotFound();
        if (row.is_archived === archived) return;
        // Waits for in-flight sends of this subscriber to get their answer.
        if (archived) await lockSubscriberSendBarrier(tx, id);
        if (!archived) await this.assertEmailFree(tx, row.email, id);
        await tx.baseSubscriber.update({
          where: { id },
          data: {
            is_archived: archived,
            archived_at: archived ? new Date() : null,
          },
        });
      }, BASE_WRITE_TX);
    } catch (error) {
      if (isUniqueViolation(error)) throw emailTaken();
      throw error;
    }
    return this.get(id);
  }
}
