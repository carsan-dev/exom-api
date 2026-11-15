import {
  HttpException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import {
  BaseDelivery,
  BaseDeliveryStatus,
  BaseServiceScope,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { enqueueWork } from '../jobs/jobs.service';
import {
  BASE_WRITE_TX,
  BaseServiceActor,
  isUniqueViolation,
  lockStaffActor,
} from './base-service.access';
import {
  BASE_DELIVERY_WORK_KIND,
  baseDeliveryWorkKey,
  MAX_EMAIL_ATTACHMENT_BASE64_BYTES,
} from './base-service.constants';
import { BaseServiceError } from './base-service.error';
import { baseHttp, mapSourceError } from './base-service.http-errors';
import {
  effectiveDeliveryStatusSql,
  failedSendPossiblyDelivered,
  SEND_STATE_UNRECORDED,
  sendFailureUnrecorded,
} from './base-delivery-state';
import {
  compareResendMaterial,
  parseRecordedFiles,
  PreparedDelivery,
  prepareDeliveryFiles,
  RecordedDeliveryFile,
  sameSources,
} from './base-delivery-files';
import {
  DeliveryPackageInput,
  deliverySendInput,
} from './base-delivery-package';
import { BasePdfSourceProvider } from './base-pdf-source.provider';
import { BasePdfStamper } from './base-pdf-stamper';
import { subscriberNotFound } from './base-subscribers.service';
import {
  basePayloadJson,
  BaseDeliveryWorkPayload,
  parseBaseDeliveryPayload,
} from './base-delivery.payload';

export type BaseSendStatus = 'PENDING' | 'SENT' | 'FAILED';

export interface BaseDeliverySendView {
  send_seq: number;
  status: BaseSendStatus;
  requested_by_id: string | null;
  requested_at: string | null;
  sent_at: string | null;
  provider_message_id: string | null;
  /** Our error code: final when FAILED, last retry cause while PENDING. */
  error: string | null;
  attempts: number;
  /** Recipient of THIS send (null only if its record is unreadable). */
  snapshot_name: string | null;
  snapshot_email: string | null;
  /**
   * FAILED and an earlier provider call of this send may have been accepted:
   * the email may have arrived. False for PENDING and SENT sends.
   */
  possibly_delivered: boolean;
  /**
   * The source PDFs of THIS send differ from the delivery's original material
   * (changed bytes or another file set), as confirmed by an admin. False when
   * the send's record or the delivery's files are unreadable.
   */
  material_changed: boolean;
  /**
   * This send was requested with `accept_changed_source: true` and needed it:
   * its material differed from the previous send's.
   */
  accepted_changed_source: boolean;
}

export interface BaseDeliveryView {
  id: string;
  subscriber_id: string;
  month: number;
  status: BaseDeliveryStatus;
  send_seq: number;
  snapshot_name: string;
  snapshot_email: string;
  snapshot_goal: string;
  snapshot_days_per_week: number;
  /** Scope contracted when the delivery was requested; all its sends use it. */
  snapshot_service_scope: BaseServiceScope;
  snapshot_order_code: string;
  files: RecordedDeliveryFile[];
  requested_by_id: string | null;
  requested_at: Date;
  sent_at: Date | null;
  provider_message_id: string | null;
  last_error: string | null;
  /** `possibly_delivered` of the latest send. */
  possibly_delivered: boolean;
  created_at: Date;
  updated_at: Date;
  /** One entry per send (1 = original request, >1 = explicit resends). */
  sends: BaseDeliverySendView[];
}

const deliveryNotFound = () =>
  baseHttp.notFound('DELIVERY_NOT_FOUND', 'Entrega no encontrada.');

const deliveryPending = () =>
  baseHttp.conflict(
    'DELIVERY_PENDING',
    'Este envío todavía está en curso. Espera a que termine antes de reenviarlo.',
  );

const deliveryChanged = () =>
  baseHttp.conflict(
    'DELIVERY_CHANGED',
    'La entrega ha cambiado mientras se preparaba el reenvío. Recarga el historial y comprueba su estado antes de volver a intentarlo.',
  );

const subscriberChanged = () =>
  baseHttp.conflict(
    'SUBSCRIBER_CHANGED',
    'El suscriptor ha cambiado mientras se preparaba el envío. Vuelve a intentarlo.',
  );

/**
 * The current catalogue material differs from the reference (the material of
 * the delivery's latest send). Same code as before accept_changed_source
 * existed, so older admin builds keep their handling.
 */
export const sourceChangedSinceDelivery = (month: number) =>
  baseHttp.conflict(
    'SOURCE_CHANGED_SINCE_DELIVERY',
    `Los PDF del mes ${month} han cambiado desde el último envío de esta entrega. El reenvío mandaría la versión actual: confirma que quieres enviarla para continuar.`,
  );

const subscriberArchived = () =>
  baseHttp.conflict(
    'SUBSCRIBER_ARCHIVED',
    'El suscriptor está archivado: desarchívalo antes de enviarle material.',
  );

interface SubscriberSnapshot {
  name: string;
  email: string;
  goal: string;
  days_per_week: number;
  /** Read as text: compared with the value the package was built for. */
  service_scope: string;
  order_code: string;
  is_archived: boolean;
}

export interface ResendOptions {
  /** The admin confirmed sending the current material although it changed. */
  acceptChangedSource?: boolean;
}

export interface SendWorkRow {
  key: string;
  status: string;
  /** durable_work.payload, parsed defensively. */
  payload: unknown;
  attempts: number;
  last_error: string | null;
}

function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

/**
 * Package errors of create and resend. The order code comes from the stored
 * subscriber/delivery and cannot be edited (trigger), so an invalid one is an
 * internal data problem, not something the admin can fix.
 */
export function mapDeliveryPackageError(error: unknown): HttpException {
  if (error instanceof BaseServiceError && error.code === 'INVALID_ORDER_CODE')
    return baseHttp.badRequest(
      'INVALID_ORDER_CODE',
      'El código de pedido guardado no es válido. Es un problema interno de datos que no se puede corregir desde aquí: avisa al equipo técnico.',
    );
  return mapSourceError(error, 'delivery');
}

/**
 * One send as the API shows it, from its durable_work row. `original` is the
 * delivery's own files (its original material), parsed.
 */
export function baseSendView(
  sendSeq: number,
  row: SendWorkRow | undefined,
  original: readonly RecordedDeliveryFile[] | null = null,
): BaseDeliverySendView {
  const payload = row ? parseBaseDeliveryPayload(row.payload) : null;
  const status: BaseSendStatus = payload?.accepted
    ? 'SENT'
    : row?.status === 'FAILED'
      ? 'FAILED'
      : 'PENDING';
  return {
    send_seq: sendSeq,
    status,
    requested_by_id: payload?.requestedById ?? null,
    requested_at: payload?.requestedAt ?? null,
    sent_at: payload?.acceptedAt ?? null,
    provider_message_id: payload?.providerMessageId ?? null,
    error: status === 'SENT' ? null : (row?.last_error ?? null),
    attempts: row?.attempts ?? 0,
    snapshot_name: payload?.name ?? null,
    snapshot_email: payload?.email ?? null,
    possibly_delivered:
      status === 'FAILED' &&
      failedSendPossiblyDelivered(
        payload,
        row?.attempts ?? 0,
        row?.last_error ?? null,
      ),
    material_changed:
      payload !== null &&
      original !== null &&
      !sameSources(original, payload.files),
    accepted_changed_source: payload?.acceptedChangedSource === true,
  };
}

/**
 * One delivery as the API shows it. Its status is the EFFECTIVE one: a
 * PENDING row whose current send is terminally FAILED (failure not recorded
 * on the row) reads FAILED with `SEND_STATE_UNRECORDED`.
 */
export function baseDeliveryView(
  delivery: BaseDelivery,
  work: ReadonlyMap<string, SendWorkRow>,
): BaseDeliveryView {
  const files = parseRecordedFiles(delivery.files);
  const sends = Array.from({ length: delivery.send_seq }, (_, index) =>
    baseSendView(
      index + 1,
      work.get(baseDeliveryWorkKey(delivery.id, index + 1)),
      files,
    ),
  );
  const unrecorded = sendFailureUnrecorded(
    delivery.status,
    work.get(baseDeliveryWorkKey(delivery.id, delivery.send_seq)),
  );
  return {
    id: delivery.id,
    subscriber_id: delivery.subscriber_id,
    month: delivery.month,
    status: unrecorded ? BaseDeliveryStatus.FAILED : delivery.status,
    send_seq: delivery.send_seq,
    snapshot_name: delivery.snapshot_name,
    snapshot_email: delivery.snapshot_email,
    snapshot_goal: delivery.snapshot_goal,
    snapshot_days_per_week: delivery.snapshot_days_per_week,
    snapshot_service_scope: delivery.snapshot_service_scope,
    snapshot_order_code: delivery.snapshot_order_code,
    files: files ?? [],
    requested_by_id: delivery.requested_by_id,
    requested_at: delivery.requested_at,
    sent_at: delivery.sent_at,
    provider_message_id: delivery.provider_message_id,
    last_error: unrecorded ? SEND_STATE_UNRECORDED : delivery.last_error,
    possibly_delivered: sends.at(-1)?.possibly_delivered ?? false,
    created_at: delivery.created_at,
    updated_at: delivery.updated_at,
    sends,
  };
}

/** Deliveries of one subscriber as seen by the next-month rules. */
export interface NextMonthState {
  max_month: number | null;
  /** Status of the requested month, if it already exists. */
  existing_status: string | null;
  /** Status of the month before the requested one, if it exists. */
  previous_status: string | null;
}

/**
 * Rules for requesting month `month`, in order: it must not exist
 * (DELIVERY_EXISTS), it must be the next one (MONTH_NOT_NEXT) and the
 * previous month must have been SENT (PREVIOUS_MONTH_NOT_SENT). Resends of an
 * existing month are not governed by these rules.
 */
export function nextMonthRuleError(
  month: number,
  state: NextMonthState,
): HttpException | null {
  if (state.existing_status)
    return baseHttp.conflict(
      'DELIVERY_EXISTS',
      `La entrega del mes ${month} ya existe. Si hay que volver a enviarla, usa «Reenviar».`,
    );
  const next = (state.max_month ?? 0) + 1;
  if (month !== next)
    return baseHttp.conflict(
      'MONTH_NOT_NEXT',
      `Solo se puede enviar el mes ${next} a este suscriptor.`,
    );
  const previous = month - 1;
  if (previous < 1 || state.previous_status === BaseDeliveryStatus.SENT)
    return null;
  return baseHttp.conflict(
    'PREVIOUS_MONTH_NOT_SENT',
    state.previous_status === BaseDeliveryStatus.FAILED
      ? `No se puede enviar el mes ${month}: el envío del mes ${previous} ha fallado. Reenvía el mes ${previous} primero y, cuando conste como enviado, envía el mes ${month}.`
      : `No se puede enviar el mes ${month}: el mes ${previous} todavía está pendiente de envío. Espera a que termine su envío antes de enviar el mes ${month}.`,
  );
}

@Injectable()
export class BaseDeliveriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sources: BasePdfSourceProvider,
    private readonly email: EmailService,
    private readonly stamper: BasePdfStamper,
  ) {}

  /**
   * Builds (and so validates) the exact package of one send outside any
   * lock: content must exist, the stamp must fit and the recorded hashes pin
   * what the job may send for this send.
   */
  private async preparePackage(
    input: DeliveryPackageInput,
  ): Promise<RecordedDeliveryFile[]> {
    let prepared: PreparedDelivery;
    try {
      prepared = await prepareDeliveryFiles(
        this.sources.source(),
        input,
        (source, options) => this.stamper.stamp(source, options),
      );
    } catch (error) {
      throw mapDeliveryPackageError(error);
    }
    const encoded = prepared.recorded.reduce(
      (total, file) => total + base64Length(file.size),
      0,
    );
    if (encoded > MAX_EMAIL_ATTACHMENT_BASE64_BYTES)
      throw baseHttp.conflict(
        'ATTACHMENTS_TOO_LARGE',
        'Los PDF de este mes superan el límite de 40 MB por email.',
      );
    return prepared.recorded;
  }

  private assertEmailConfigured(): void {
    if (!this.email.resendSender())
      throw baseHttp.unavailable(
        'EMAIL_NOT_CONFIGURED',
        'El envío de emails (Resend) no está configurado.',
      );
  }

  /**
   * N must be max(month) + 1, or 1, and month N-1 must be SENT; an existing
   * month is never recreated. One statement, so under the subscriber row
   * lock every rule reads the same committed state. Statuses are the
   * EFFECTIVE ones: an unrecorded failure of N-1 counts as FAILED.
   */
  private async assertNextMonth(
    db: Pick<Prisma.TransactionClient, '$queryRaw'>,
    subscriberId: string,
    month: number,
  ): Promise<void> {
    const [row] = await db.$queryRaw<NextMonthState[]>`
      SELECT max(d.month) AS max_month,
        max(${effectiveDeliveryStatusSql}) FILTER (WHERE d.month = ${month}) AS existing_status,
        max(${effectiveDeliveryStatusSql}) FILTER (WHERE d.month = ${month - 1}) AS previous_status
      FROM base_deliveries d WHERE d.subscriber_id = ${subscriberId}`;
    const error = nextMonthRuleError(
      month,
      row ?? { max_month: null, existing_status: null, previous_status: null },
    );
    if (error) throw error;
  }

  async create(
    subscriberId: string,
    month: number,
    actor: BaseServiceActor,
  ): Promise<BaseDeliveryView> {
    if (!Number.isInteger(month) || month < 1)
      throw baseHttp.badRequest(
        'INVALID_MONTH',
        'El mes debe ser 1 o superior.',
      );
    const subscriber = await this.prisma.baseSubscriber.findUnique({
      where: { id: subscriberId },
      select: {
        name: true,
        email: true,
        goal: true,
        days_per_week: true,
        service_scope: true,
        order_code: true,
        is_archived: true,
      },
    });
    if (!subscriber) throw subscriberNotFound();
    if (subscriber.is_archived) throw subscriberArchived();
    // Cheap rejections before any catalogue I/O; repeated under the lock.
    await this.assertNextMonth(this.prisma, subscriberId, month);
    this.assertEmailConfigured();

    const recorded = await this.preparePackage({
      name: subscriber.name,
      email: subscriber.email,
      orderCode: subscriber.order_code,
      objetivo: subscriber.goal,
      dias: subscriber.days_per_week,
      mes: month,
      scope: subscriber.service_scope,
    });

    let deliveryId: string;
    try {
      deliveryId = await this.prisma.$transaction(async (tx) => {
        await lockStaffActor(tx, actor);
        const [locked] = await tx.$queryRaw<SubscriberSnapshot[]>`
          SELECT name, email, goal, days_per_week,
            service_scope::text AS service_scope, order_code, is_archived
          FROM base_subscribers WHERE id = ${subscriberId} FOR UPDATE`;
        if (!locked) throw subscriberNotFound();
        if (locked.is_archived) throw subscriberArchived();
        if (
          locked.name !== subscriber.name ||
          locked.email !== subscriber.email ||
          locked.goal !== subscriber.goal ||
          locked.days_per_week !== subscriber.days_per_week ||
          locked.service_scope !== subscriber.service_scope ||
          locked.order_code !== subscriber.order_code
        )
          throw subscriberChanged();
        // Serialised by the row lock; the unique index is the backstop.
        await this.assertNextMonth(tx, subscriberId, month);
        const requestedAt = new Date();
        const delivery = await tx.baseDelivery.create({
          data: {
            subscriber_id: subscriberId,
            month,
            status: BaseDeliveryStatus.PENDING,
            send_seq: 1,
            snapshot_name: locked.name,
            snapshot_email: locked.email,
            snapshot_goal: locked.goal,
            snapshot_days_per_week: locked.days_per_week,
            // Equal to the locked value (checked above); typed as the enum.
            snapshot_service_scope: subscriber.service_scope,
            snapshot_order_code: locked.order_code,
            files: recorded.map((file) => ({ ...file })),
            requested_by_id: actor.id,
            requested_at: requestedAt,
          },
          select: { id: true },
        });
        await this.enqueueSend(tx, {
          deliveryId: delivery.id,
          sendSeq: 1,
          requestedById: actor.id,
          requestedAt: requestedAt.toISOString(),
          name: locked.name,
          email: locked.email,
          files: recorded,
        });
        return delivery.id;
      }, BASE_WRITE_TX);
    } catch (error) {
      if (isUniqueViolation(error))
        throw baseHttp.conflict(
          'DELIVERY_EXISTS',
          `La entrega del mes ${month} ya existe. Si hay que volver a enviarla, usa «Reenviar».`,
        );
      throw error;
    }
    return this.view(deliveryId);
  }

  /** Outbox: the work row commits with the business row or not at all. */
  private async enqueueSend(
    tx: Prisma.TransactionClient,
    payload: BaseDeliveryWorkPayload,
  ): Promise<void> {
    const { count } = await enqueueWork(
      tx,
      baseDeliveryWorkKey(payload.deliveryId, payload.sendSeq),
      BASE_DELIVERY_WORK_KIND,
      basePayloadJson(payload),
    );
    if (count !== 1)
      throw baseHttp.conflict(
        'SEND_ALREADY_QUEUED',
        'Este envío ya estaba en cola. Recarga el historial.',
      );
  }

  /**
   * Explicit resend of a SENT or (effectively) FAILED delivery: send_seq + 1
   * and a new idempotency key, so the provider sends again. Under the lock
   * the delivery must still be in the state the request was prepared
   * against (409 DELIVERY_CHANGED otherwise). The new send goes to the
   * subscriber's CURRENT name and email (re-validated and re-stamped exactly
   * like a new delivery); goal, days, scope, month and order code stay those
   * of the delivery. The package is the CURRENT catalogue material of that month and
   * route; if it differs (bytes or file set) from the reference, the material
   * recorded by the delivery's latest send, the resend needs
   * `acceptChangedSource` (409 SOURCE_CHANGED_SINCE_DELIVERY otherwise). The
   * reference moves only when a resend commits (it is that new send's
   * record), whatever its outcome. Any rejection changes nothing.
   */
  async resend(
    subscriberId: string,
    deliveryId: string,
    actor: BaseServiceActor,
    options: ResendOptions = {},
  ): Promise<BaseDeliveryView> {
    this.assertEmailConfigured();
    try {
      this.sources.source();
    } catch (error) {
      throw mapSourceError(error, 'delivery');
    }
    const [subscriber, delivery] = await Promise.all([
      this.prisma.baseSubscriber.findUnique({
        where: { id: subscriberId },
        select: { name: true, email: true, is_archived: true },
      }),
      this.prisma.baseDelivery.findFirst({
        where: { id: deliveryId, subscriber_id: subscriberId },
      }),
    ]);
    // Cheap rejections before any catalogue I/O; repeated under the lock.
    if (!subscriber) throw subscriberNotFound();
    if (!delivery) throw deliveryNotFound();
    if (subscriber.is_archived) throw subscriberArchived();
    // PENDING is in progress unless its send already ended FAILED without
    // the row recording it (effective state FAILED: resendable).
    if (
      delivery.status === BaseDeliveryStatus.PENDING &&
      !(await this.sendFailureUnrecorded(
        this.prisma,
        delivery.id,
        delivery.send_seq,
      ))
    )
      throw deliveryPending();
    const deliveryFiles = parseRecordedFiles(delivery.files);
    if (!deliveryFiles)
      throw new InternalServerErrorException('BASE_DELIVERY_FILES_INVALID');
    // Valid for this send_seq only: re-checked under the lock below
    // (DELIVERY_CHANGED), and a send's recorded files are never rewritten.
    const reference = await this.referenceFiles(
      this.prisma,
      delivery.id,
      delivery.send_seq,
      deliveryFiles,
    );

    const files = await this.preparePackage(
      deliverySendInput(delivery, subscriber),
    );
    const material = compareResendMaterial(deliveryFiles, reference, files);
    if (material.changedSinceReference && options.acceptChangedSource !== true)
      throw sourceChangedSinceDelivery(delivery.month);

    await this.prisma.$transaction(async (tx) => {
      await lockStaffActor(tx, actor);
      const [locked] = await tx.$queryRaw<
        { name: string; email: string; is_archived: boolean }[]
      >`SELECT name, email, is_archived FROM base_subscribers WHERE id = ${subscriberId} FOR UPDATE`;
      if (!locked) throw subscriberNotFound();
      if (locked.is_archived) throw subscriberArchived();
      // The package was stamped with the values read before the lock.
      if (locked.name !== subscriber.name || locked.email !== subscriber.email)
        throw subscriberChanged();
      const [current] = await tx.$queryRaw<
        { status: string; send_seq: number }[]
      >`SELECT status::text AS status, send_seq FROM base_deliveries
        WHERE id = ${deliveryId} AND subscriber_id = ${subscriberId} FOR UPDATE`;
      if (!current) throw deliveryNotFound();
      // The package and the checks above were made against the state read
      // before the lock: another resend committed meanwhile (even one already
      // sent) must not be followed by a second new send.
      if (
        current.send_seq !== delivery.send_seq ||
        current.status !== delivery.status
      )
        throw deliveryChanged();
      if (current.status === BaseDeliveryStatus.PENDING) {
        if (
          !(await this.sendFailureUnrecorded(tx, deliveryId, current.send_seq))
        )
          throw deliveryPending();
        // Record the failure of that send before opening the next one.
        const { count } = await tx.baseDelivery.updateMany({
          where: {
            id: deliveryId,
            send_seq: current.send_seq,
            status: BaseDeliveryStatus.PENDING,
          },
          data: {
            status: BaseDeliveryStatus.FAILED,
            last_error: SEND_STATE_UNRECORDED,
          },
        });
        if (count !== 1) throw deliveryChanged();
      }
      const sendSeq = current.send_seq + 1;
      const requestedAt = new Date();
      await tx.baseDelivery.update({
        where: { id: deliveryId },
        // sent_at/provider_message_id keep the latest ACCEPTED send; the
        // recipient snapshot becomes that of the new (latest) send.
        data: {
          status: BaseDeliveryStatus.PENDING,
          send_seq: sendSeq,
          last_error: null,
          snapshot_name: locked.name,
          snapshot_email: locked.email,
        },
      });
      await this.enqueueSend(tx, {
        deliveryId,
        sendSeq,
        requestedById: actor.id,
        requestedAt: requestedAt.toISOString(),
        name: locked.name,
        email: locked.email,
        files,
        // Unchanged material: the same record as before this option existed.
        materialChanged: material.materialChanged || undefined,
        acceptedChangedSource: material.changedSinceReference || undefined,
      });
    }, BASE_WRITE_TX);
    return this.view(deliveryId);
  }

  /**
   * Reference material of a resend: the sources recorded by the delivery's
   * CURRENT send (`send_seq`, its work payload), whatever that send's
   * outcome. Falls back to the delivery's original files when that record is
   * missing or unreadable (not produced by the API): the comparison is then
   * against the original material, as before accept_changed_source existed.
   */
  private async referenceFiles(
    db: Pick<Prisma.TransactionClient, 'durableWork'>,
    deliveryId: string,
    sendSeq: number,
    original: RecordedDeliveryFile[],
  ): Promise<RecordedDeliveryFile[]> {
    const work = await db.durableWork.findUnique({
      where: { key: baseDeliveryWorkKey(deliveryId, sendSeq) },
      select: { kind: true, payload: true },
    });
    const payload =
      work?.kind === BASE_DELIVERY_WORK_KIND
        ? parseBaseDeliveryPayload(work.payload)
        : null;
    return payload?.deliveryId === deliveryId && payload.sendSeq === sendSeq
      ? payload.files
      : original;
  }

  async list(subscriberId: string): Promise<BaseDeliveryView[]> {
    return this.prisma.$transaction(
      async (tx) => {
        const subscriber = await tx.baseSubscriber.findUnique({
          where: { id: subscriberId },
          select: { id: true },
        });
        if (!subscriber) throw subscriberNotFound();
        const deliveries = await tx.baseDelivery.findMany({
          where: { subscriber_id: subscriberId },
          orderBy: { month: 'asc' },
        });
        return this.withSends(tx, deliveries);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  private async view(deliveryId: string): Promise<BaseDeliveryView> {
    const delivery = await this.prisma.baseDelivery.findUnique({
      where: { id: deliveryId },
    });
    if (!delivery) throw deliveryNotFound();
    const [view] = await this.withSends(this.prisma, [delivery]);
    return view;
  }

  private async withSends(
    db: Pick<Prisma.TransactionClient, 'durableWork'>,
    deliveries: BaseDelivery[],
  ): Promise<BaseDeliveryView[]> {
    const keys = deliveries.flatMap((delivery) =>
      Array.from({ length: delivery.send_seq }, (_, index) =>
        baseDeliveryWorkKey(delivery.id, index + 1),
      ),
    );
    const work = keys.length
      ? await db.durableWork.findMany({
          where: { key: { in: keys }, kind: BASE_DELIVERY_WORK_KIND },
          select: {
            key: true,
            status: true,
            payload: true,
            attempts: true,
            last_error: true,
          },
        })
      : [];
    const byKey = new Map(work.map((row) => [row.key, row]));
    return deliveries.map((delivery) => baseDeliveryView(delivery, byKey));
  }

  /** Whether the delivery's send `sendSeq` ended FAILED without the row knowing. */
  private async sendFailureUnrecorded(
    db: Pick<Prisma.TransactionClient, 'durableWork'>,
    deliveryId: string,
    sendSeq: number,
  ): Promise<boolean> {
    const work = await db.durableWork.findUnique({
      where: { key: baseDeliveryWorkKey(deliveryId, sendSeq) },
      select: { kind: true, status: true, payload: true },
    });
    return (
      work?.kind === BASE_DELIVERY_WORK_KIND &&
      sendFailureUnrecorded(BaseDeliveryStatus.PENDING, work)
    );
  }
}
