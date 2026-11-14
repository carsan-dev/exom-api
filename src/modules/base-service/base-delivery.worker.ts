import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BaseDelivery,
  BaseDeliveryStatus,
  DurableWork,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailService, ResendAttachment } from '../email/email.service';
import {
  JobsService,
  PermanentWorkError,
  RetryWorkError,
  WorkRunContext,
} from '../jobs/jobs.service';
import {
  BASE_DELIVERY_WORK_KIND,
  BASE_EMAIL_DEDUP_WINDOW_MS,
  baseDeliveryWorkKey,
} from './base-service.constants';
import { subscriberSendBarrierKey } from './base-service.access';
import { BaseServiceError } from './base-service.error';
import {
  assertMatchesRecorded,
  parseRecordedFiles,
  prepareDeliveryFiles,
  PreparedDelivery,
  sameSources,
} from './base-delivery-files';
import { buildBaseDeliveryEmail } from './base-delivery-email';
import {
  basePayloadJson,
  BaseDeliveryWorkPayload,
  parseBaseDeliveryPayload,
  SavedBaseEmailRequest,
  sendPossiblyDelivered,
} from './base-delivery.payload';
import {
  BasePdfSourceProvider,
  BaseSourceNotConfiguredError,
} from './base-pdf-source.provider';
import { BasePdfStamper } from './base-pdf-stamper';

/**
 * Handler of BASE_DELIVERY_EMAIL durable work: one email with the stamped
 * PDFs of one (delivery, send_seq). Error codes are ours; the delivery row is
 * marked FAILED atomically with the terminal work failure (JobsService hook),
 * which also records whether the send may have been delivered anyway.
 *
 * No Prisma transaction or row lock is held while stamping or while waiting
 * for the provider: the archive-vs-send guarantee comes from the shared
 * subscriber send barrier, taken on the work-guard connection that the job
 * runner pins for the whole item.
 */
@Injectable()
export class BaseDeliveryWorker implements OnModuleInit {
  private readonly supportUrl?: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly email: EmailService,
    private readonly sources: BasePdfSourceProvider,
    config: ConfigService,
    private readonly stamper: BasePdfStamper,
  ) {
    this.supportUrl = config.get<string>('SUPPORT_URL')?.trim() || undefined;
  }

  onModuleInit() {
    this.jobs.register(
      BASE_DELIVERY_WORK_KIND,
      (work, context) => this.deliver(work, context),
      {
        payloadAcceptance: true,
        onTerminalFailure: (tx, work, code) => this.markFailed(tx, work, code),
      },
    );
  }

  /**
   * Terminal failure of one send, in the transaction that marks the work
   * FAILED. Reads the CURRENT payload (the runner's copy predates this
   * attempt's hand-off) to classify the failure.
   */
  async markFailed(
    tx: Prisma.TransactionClient,
    work: DurableWork,
    code: string | null,
  ): Promise<void> {
    const row = await tx.durableWork.findUnique({
      where: { key: work.key },
      select: { payload: true, attempts: true },
    });
    const payload = row ? parseBaseDeliveryPayload(row.payload) : null;
    if (!row || !payload) return;
    await tx.durableWork.update({
      where: { key: work.key },
      data: {
        payload: basePayloadJson({
          ...payload,
          possiblyDelivered: sendPossiblyDelivered(payload, row.attempts, code),
        }),
      },
    });
    // Only the send this work belongs to, and never over an acceptance.
    await tx.baseDelivery.updateMany({
      where: {
        id: payload.deliveryId,
        send_seq: payload.sendSeq,
        status: BaseDeliveryStatus.PENDING,
      },
      data: {
        status: BaseDeliveryStatus.FAILED,
        last_error: (code ?? 'ATTEMPT_FAILED_OR_AMBIGUOUS').slice(0, 64),
      },
    });
  }

  async deliver(work: DurableWork, context: WorkRunContext): Promise<void> {
    const payload = parseBaseDeliveryPayload(work.payload);
    if (
      !payload ||
      work.key !== baseDeliveryWorkKey(payload.deliveryId, payload.sendSeq)
    )
      throw new PermanentWorkError('INVALID_BASE_DELIVERY_INTENT');
    // The receipt and SENT were committed together: nothing left to do.
    if (payload.accepted) return;
    if (!work.claim_token) throw new PermanentWorkError('CLAIM_REQUIRED');
    const claim = {
      key: work.key,
      claim_token: work.claim_token,
      status: 'RUNNING',
    };

    const delivery = await this.prisma.baseDelivery.findUnique({
      where: { id: payload.deliveryId },
    });
    if (!delivery) throw new PermanentWorkError('BASE_DELIVERY_NOT_FOUND');
    this.assertCurrentSend(delivery, payload);
    // The delivery row mirrors the recipient of its latest send (trigger:
    // it only changes together with a new send_seq).
    if (
      delivery.snapshot_name !== payload.name ||
      delivery.snapshot_email !== payload.email
    )
      throw new PermanentWorkError('EMAIL_RECIPIENT_CHANGED');
    const sender = this.email.resendSender();
    if (!sender) throw new PermanentWorkError('EMAIL_PROVIDER_NOT_CONFIGURED');
    if (payload.preparedAt !== undefined) {
      const preparedAt = Date.parse(payload.preparedAt);
      // Past the provider's 24 h key window a retry could send twice.
      if (
        !Number.isFinite(preparedAt) ||
        Date.now() - preparedAt >= BASE_EMAIL_DEDUP_WINDOW_MS
      )
        throw new PermanentWorkError('EMAIL_DEDUP_WINDOW_EXPIRED');
    }
    const deliveryFiles = parseRecordedFiles(delivery.files);
    if (!deliveryFiles || !sameSources(deliveryFiles, payload.files))
      throw new PermanentWorkError('BASE_DELIVERY_FILES_INVALID');

    // Catalogue reads and stamping: no transaction, no lock.
    const attachments = await this.buildAttachments(delivery, payload);
    const request =
      payload.request ?? this.buildRequest(sender, delivery, payload);
    if (request.to !== payload.email)
      throw new PermanentWorkError('EMAIL_RECIPIENT_CHANGED');

    // Archive barrier (shared), held until this work item ends. An archive
    // committed before this point is seen below; a later one waits for us.
    await context.guard.query(
      'SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))::text AS locked',
      [subscriberSendBarrierKey(delivery.subscriber_id)],
    );
    const subscriber = await this.prisma.baseSubscriber.findUnique({
      where: { id: delivery.subscriber_id },
      select: { is_archived: true },
    });
    if (!subscriber) throw new PermanentWorkError('BASE_SUBSCRIBER_NOT_FOUND');
    if (subscriber.is_archived)
      throw new PermanentWorkError('SUBSCRIBER_ARCHIVED');
    const current = await this.prisma.baseDelivery.findUnique({
      where: { id: delivery.id },
      select: { send_seq: true, status: true },
    });
    if (!current) throw new PermanentWorkError('BASE_DELIVERY_NOT_FOUND');
    this.assertCurrentSend(current, payload);

    // Count the hand-off BEFORE the call (and, the first time, persist the
    // exact body minus attachments, which are rebuilt and hash-checked):
    // every retry reuses it with the same Idempotency-Key, and a terminal
    // failure after any hand-off is reported as possibly delivered.
    const prepared: BaseDeliveryWorkPayload = {
      ...payload,
      preparedAt: payload.preparedAt ?? new Date().toISOString(),
      request,
      handoffs: (payload.handoffs ?? 0) + 1,
      lastHandoffAttempt: work.attempts,
    };
    const { count } = await this.prisma.durableWork.updateMany({
      where: claim,
      data: { payload: basePayloadJson(prepared) },
    });
    if (count !== 1) throw new PermanentWorkError('CLAIM_LOST');

    const result = await this.email.sendResendEmail(
      { ...request, attachments },
      work.key,
    );
    if (result.outcome !== 'accepted')
      throw result.outcome === 'transient'
        ? new RetryWorkError(result.code)
        : new PermanentWorkError(result.code);

    const acceptedAt = new Date();
    await this.prisma.$transaction([
      this.prisma.durableWork.update({
        where: claim,
        // The saved request body is dropped on acceptance; the send keeps its
        // recipient (name, email) and files as history.
        data: {
          payload: basePayloadJson({
            ...prepared,
            request: undefined,
            accepted: true,
            providerMessageId: result.id,
            acceptedAt: acceptedAt.toISOString(),
          }),
        },
      }),
      this.prisma.baseDelivery.updateMany({
        where: {
          id: delivery.id,
          send_seq: payload.sendSeq,
          status: BaseDeliveryStatus.PENDING,
        },
        data: {
          status: BaseDeliveryStatus.SENT,
          sent_at: acceptedAt,
          provider_message_id: result.id.slice(0, 200),
          last_error: null,
        },
      }),
    ]);
  }

  private assertCurrentSend(
    delivery: Pick<BaseDelivery, 'send_seq' | 'status'>,
    payload: BaseDeliveryWorkPayload,
  ): void {
    if (
      delivery.send_seq !== payload.sendSeq ||
      delivery.status !== BaseDeliveryStatus.PENDING
    )
      throw new PermanentWorkError('BASE_DELIVERY_SUPERSEDED');
  }

  private buildRequest(
    sender: string,
    delivery: BaseDelivery,
    payload: BaseDeliveryWorkPayload,
  ): SavedBaseEmailRequest {
    const content = buildBaseDeliveryEmail({
      name: payload.name,
      month: delivery.month,
      daysPerWeek: delivery.snapshot_days_per_week,
      files: payload.files,
      logoUrl: this.email.emailLogoUrl(),
      supportUrl: this.supportUrl,
    });
    return {
      from: sender,
      to: payload.email,
      subject: content.subject,
      html: content.html,
      text: content.text,
    };
  }

  /**
   * Rebuilds the stamped PDFs of THIS send (its recipient, the delivery's
   * route) and checks them against the hashes the send recorded.
   */
  private async buildAttachments(
    delivery: BaseDelivery,
    payload: BaseDeliveryWorkPayload,
  ): Promise<ResendAttachment[]> {
    let prepared: PreparedDelivery;
    try {
      prepared = await prepareDeliveryFiles(
        this.sources.source(),
        {
          name: payload.name,
          email: payload.email,
          orderCode: delivery.snapshot_order_code,
          objetivo: delivery.snapshot_goal,
          dias: delivery.snapshot_days_per_week,
          mes: delivery.month,
        },
        (source, options) => this.stamper.stamp(source, options),
      );
    } catch (error) {
      if (error instanceof BaseSourceNotConfiguredError)
        throw new PermanentWorkError('BASE_SOURCE_NOT_CONFIGURED');
      if (error instanceof BaseServiceError) {
        if (error.code === 'SOURCE_NOT_FOUND')
          throw new PermanentWorkError('BASE_SOURCE_NOT_FOUND');
        // Retrying cannot shorten the snapshot: never send a clipped stamp.
        if (error.code === 'STAMP_TOO_LONG')
          throw new PermanentWorkError('BASE_STAMP_TOO_LONG');
        if (
          error.code === 'INVALID_NAME' ||
          error.code === 'INVALID_EMAIL' ||
          error.code === 'INVALID_ORDER_CODE'
        )
          throw new PermanentWorkError('BASE_SNAPSHOT_INVALID');
        throw new PermanentWorkError('BASE_CONTENT_UNAVAILABLE');
      }
      // Storage/network trouble: retry with backoff.
      throw new RetryWorkError('BASE_SOURCE_UNAVAILABLE');
    }
    try {
      assertMatchesRecorded(payload.files, prepared);
    } catch {
      throw new PermanentWorkError('BASE_SOURCE_CHANGED');
    }
    return prepared.package.files.map((file) => ({
      filename: file.filename,
      content: Buffer.from(file.bytes).toString('base64'),
    }));
  }
}
