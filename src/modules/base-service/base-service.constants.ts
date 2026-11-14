import { Role } from '@prisma/client';

/**
 * Staff roles allowed to manage base subscribers and send deliveries. Every
 * base-service route uses this single list, so tightening it (for example to
 * SUPER_ADMIN only) is a one-line change.
 */
export const BASE_SERVICE_ROLES: readonly Role[] = [
  Role.ADMIN,
  Role.SUPER_ADMIN,
];

/** Durable-work kind of the monthly delivery email (one per send). */
export const BASE_DELIVERY_WORK_KIND = 'BASE_DELIVERY_EMAIL';

/**
 * Durable-work key, also used as the Resend Idempotency-Key: stable across
 * retries of one send and different for every explicit resend.
 */
export function baseDeliveryWorkKey(deliveryId: string, sendSeq: number) {
  return `base-delivery:${deliveryId}:${sendSeq}`;
}

export const BASE_ENV = {
  /** Dedicated PRIVATE bucket with the source PDFs (never the media bucket). */
  BUCKET: 'R2_BASE_PDF_BUCKET',
  /** Local directory with the source PDFs; ignored when NODE_ENV=production. */
  LOCAL_DIR: 'BASE_PDF_LOCAL_DIR',
} as const;

/** Resend accepts at most 40 MB per email, measured after Base64 encoding. */
export const MAX_EMAIL_ATTACHMENT_BASE64_BYTES = 40 * 1024 * 1024;

/**
 * The provider keeps idempotency keys for 24 h; stop retrying an already
 * prepared send at 23 h, like the existing EMAIL worker.
 */
export const BASE_EMAIL_DEDUP_WINDOW_MS = 23 * 3600 * 1000;
