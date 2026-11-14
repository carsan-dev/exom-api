import { BaseDeliveryStatus, Prisma } from '@prisma/client';
import { BASE_DELIVERY_WORK_KIND } from './base-service.constants';
import {
  BaseDeliveryWorkPayload,
  sendPossiblyDelivered,
} from './base-delivery.payload';

/**
 * Delivery-level error of a send whose work item ended FAILED without the
 * terminal hook recording it on the delivery row (the hook failed every
 * try): the row still says PENDING, but that send is over.
 */
export const SEND_STATE_UNRECORDED = 'SEND_STATE_UNRECORDED';

/** The part of a send's durable_work row the effective state depends on. */
export interface SendWorkState {
  status: string;
  payload: unknown;
}

/** Same test as the SQL below: the payload records a provider acceptance. */
function workPayloadAccepted(payload: unknown): boolean {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    !Array.isArray(payload) &&
    'accepted' in payload &&
    payload.accepted === true
  );
}

/**
 * Effective-state rule: a PENDING delivery whose CURRENT send (its send_seq)
 * has a terminally FAILED, unaccepted work item is FAILED. FAILED work rows
 * are never claimed again, so this cannot flip back. Must match
 * `effectiveDeliveryStatusSql`.
 */
export function sendFailureUnrecorded(
  deliveryStatus: string,
  work: SendWorkState | null | undefined,
): boolean {
  return (
    deliveryStatus === BaseDeliveryStatus.PENDING &&
    work?.status === 'FAILED' &&
    !workPayloadAccepted(work.payload)
  );
}

/**
 * `possibly_delivered` of a FAILED send. The flag stored by the terminal hook
 * wins; without it (hook never ran) it is recomputed from the counted
 * hand-offs with the same rule; an unreadable record answers true (the safe
 * side: the email may have arrived).
 */
export function failedSendPossiblyDelivered(
  payload: BaseDeliveryWorkPayload | null,
  attempts: number,
  lastError: string | null,
): boolean {
  if (!payload) return true;
  if (payload.possiblyDelivered !== undefined) return payload.possiblyDelivered;
  return sendPossiblyDelivered(payload, attempts, lastError);
}

/**
 * SQL form of `sendFailureUnrecorded` for a `base_deliveries` row aliased
 * `d`, as text. The key literal mirrors `baseDeliveryWorkKey`.
 */
export const effectiveDeliveryStatusSql = Prisma.sql`CASE
  WHEN d.status = 'PENDING' AND EXISTS (
    SELECT 1 FROM durable_work w
    WHERE w.key = 'base-delivery:' || d.id || ':' || d.send_seq
      AND w.kind = ${BASE_DELIVERY_WORK_KIND}
      AND w.status = 'FAILED'
      AND w.payload -> 'accepted' IS DISTINCT FROM 'true'::jsonb)
  THEN 'FAILED' ELSE d.status::text END`;

export function parseDeliveryStatus(value: string): BaseDeliveryStatus | null {
  return (
    Object.values(BaseDeliveryStatus).find((status) => status === value) ?? null
  );
}
