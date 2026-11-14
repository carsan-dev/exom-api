import { Prisma } from '@prisma/client';
import {
  parseRecordedFiles,
  RecordedDeliveryFile,
} from './base-delivery-files';

/** Exact non-attachment part of the provider request, fixed before sending. */
export interface SavedBaseEmailRequest {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * `durable_work.payload` of a BASE_DELIVERY_EMAIL send: the record of ONE
 * send (send_seq). Written by the producer: identity, the recipient snapshot
 * of this send (`name`, `email`) and its files (source hashes, which never
 * change within a delivery, and the stamped hashes recorded when the send was
 * created). Before every provider call the worker persists `preparedAt` and
 * `request` (first call only) and bumps `handoffs`/`lastHandoffAttempt`.
 * On acceptance `accepted`/`providerMessageId`/`acceptedAt` are added and the
 * saved request body is dropped; on a terminal failure `possiblyDelivered`
 * records whether an earlier hand-off may have reached the provider.
 */
export interface BaseDeliveryWorkPayload {
  deliveryId: string;
  sendSeq: number;
  requestedById: string | null;
  requestedAt: string;
  name: string;
  email: string;
  files: RecordedDeliveryFile[];
  preparedAt?: string;
  request?: SavedBaseEmailRequest;
  /** Provider calls started for this send (persisted before each call). */
  handoffs?: number;
  /** durable_work.attempts of the attempt that made the latest call. */
  lastHandoffAttempt?: number;
  possiblyDelivered?: boolean;
  accepted?: true;
  providerMessageId?: string;
  acceptedAt?: string;
}

/**
 * Provider answers that prove THAT call did not send anything (the request
 * was refused, or never left because Resend was not configured).
 */
export const DEFINITIVE_PROVIDER_REJECTIONS: ReadonlySet<string> = new Set([
  'EMAIL_REQUEST_REJECTED',
  'EMAIL_PROVIDER_AUTH_REJECTED',
  'EMAIL_PROVIDER_REJECTED',
  'EMAIL_PROVIDER_NOT_CONFIGURED',
]);

/**
 * Classifies a terminal failure of one send. False ("nothing sent") only when
 * no provider call was ever started for it, or when the single call that was
 * started was made by the failing attempt and answered with a definitive
 * rejection. Any other combination may hide an earlier acceptance whose
 * response was lost: the email may have arrived.
 */
export function sendPossiblyDelivered(
  payload: Pick<BaseDeliveryWorkPayload, 'handoffs' | 'lastHandoffAttempt'>,
  failingAttempt: number,
  code: string | null,
): boolean {
  const handoffs = payload.handoffs ?? 0;
  if (handoffs === 0) return false;
  if (handoffs > 1) return true;
  return !(
    payload.lastHandoffAttempt === failingAttempt &&
    code !== null &&
    DEFINITIVE_PROVIDER_REJECTIONS.has(code)
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function parseRequest(value: unknown): SavedBaseEmailRequest | null {
  if (!isObject(value)) return null;
  const { from, to, subject, html, text } = value;
  if (
    typeof from !== 'string' ||
    typeof to !== 'string' ||
    typeof subject !== 'string' ||
    typeof html !== 'string' ||
    typeof text !== 'string'
  )
    return null;
  return { from, to, subject, html, text };
}

export function parseBaseDeliveryPayload(
  value: unknown,
): BaseDeliveryWorkPayload | null {
  if (!isObject(value)) return null;
  const { deliveryId, sendSeq, requestedById, requestedAt, name, email } =
    value;
  if (
    typeof deliveryId !== 'string' ||
    !deliveryId ||
    !isPositiveInteger(sendSeq) ||
    (requestedById !== null && typeof requestedById !== 'string') ||
    typeof requestedAt !== 'string' ||
    typeof name !== 'string' ||
    !name ||
    typeof email !== 'string' ||
    !email
  )
    return null;
  const files = parseRecordedFiles(value.files);
  if (!files) return null;
  const payload: BaseDeliveryWorkPayload = {
    deliveryId,
    sendSeq,
    requestedById,
    requestedAt,
    name,
    email,
    files,
  };
  if (value.preparedAt !== undefined) {
    if (typeof value.preparedAt !== 'string') return null;
    payload.preparedAt = value.preparedAt;
  }
  if (value.request !== undefined) {
    const request = parseRequest(value.request);
    if (!request) return null;
    payload.request = request;
  }
  if (value.handoffs !== undefined || value.lastHandoffAttempt !== undefined) {
    if (
      !isPositiveInteger(value.handoffs) ||
      !isPositiveInteger(value.lastHandoffAttempt)
    )
      return null;
    payload.handoffs = value.handoffs;
    payload.lastHandoffAttempt = value.lastHandoffAttempt;
  }
  // Every provider call is counted before it starts.
  if (payload.preparedAt !== undefined && payload.handoffs === undefined)
    return null;
  if (value.possiblyDelivered !== undefined) {
    if (typeof value.possiblyDelivered !== 'boolean') return null;
    payload.possiblyDelivered = value.possiblyDelivered;
  }
  if (value.accepted !== undefined) {
    if (
      value.accepted !== true ||
      typeof value.providerMessageId !== 'string' ||
      typeof value.acceptedAt !== 'string'
    )
      return null;
    payload.accepted = true;
    payload.providerMessageId = value.providerMessageId;
    payload.acceptedAt = value.acceptedAt;
  }
  return payload;
}

export function basePayloadJson(
  payload: BaseDeliveryWorkPayload,
): Prisma.InputJsonObject {
  const json: Record<string, Prisma.InputJsonValue | null> = {
    deliveryId: payload.deliveryId,
    sendSeq: payload.sendSeq,
    requestedById: payload.requestedById,
    requestedAt: payload.requestedAt,
    name: payload.name,
    email: payload.email,
    files: payload.files.map((file) => ({ ...file })),
  };
  if (payload.preparedAt !== undefined) json.preparedAt = payload.preparedAt;
  if (payload.request !== undefined) json.request = { ...payload.request };
  if (
    payload.handoffs !== undefined &&
    payload.lastHandoffAttempt !== undefined
  ) {
    json.handoffs = payload.handoffs;
    json.lastHandoffAttempt = payload.lastHandoffAttempt;
  }
  if (payload.possiblyDelivered !== undefined)
    json.possiblyDelivered = payload.possiblyDelivered;
  if (payload.accepted) {
    json.accepted = true;
    json.providerMessageId = payload.providerMessageId ?? null;
    json.acceptedAt = payload.acceptedAt ?? null;
  }
  return json;
}
