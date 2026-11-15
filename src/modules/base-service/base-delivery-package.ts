import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { BaseDelivery, BaseServiceScope } from '@prisma/client';
import {
  assertSubscriberStampFits,
  normalizeClientName,
  normalizeOrderCode,
  normalizeSubscriberEmail,
} from './base-delivery-input';
import { selectPackage } from './base-package-selection';
import { BasePdfSource } from './base-pdf-source';
import {
  buildStampKeywords,
  buildStampSubject,
  buildStampText,
  stampPdf,
  StampOptions,
} from './base-pdf-stamp';

/** Stamping function; injectable so tests can simulate a library change. */
export type PdfStampFn = (
  source: Uint8Array,
  options: StampOptions,
) => Promise<Uint8Array>;

export interface DeliveryPackageInput {
  name: string;
  /** Address the package is sent to; printed on every page. */
  email: string;
  orderCode: string;
  objetivo: string;
  dias: number;
  mes: number;
  /** What the subscriber contracted; decides which PDFs are included. */
  scope: BaseServiceScope;
}

/** The request snapshot of a delivery that every send of it reuses. */
export type DeliveryRequestSnapshot = Pick<
  BaseDelivery,
  | 'month'
  | 'snapshot_goal'
  | 'snapshot_days_per_week'
  | 'snapshot_service_scope'
  | 'snapshot_order_code'
>;

/**
 * Package input of one send (retry or resend) of an existing delivery:
 * route, month, order code and scope are the delivery's request snapshot,
 * never the subscriber's current values; only the recipient belongs to the
 * send.
 */
export function deliverySendInput(
  delivery: DeliveryRequestSnapshot,
  recipient: { name: string; email: string },
): DeliveryPackageInput {
  return {
    name: recipient.name,
    email: recipient.email,
    orderCode: delivery.snapshot_order_code,
    objetivo: delivery.snapshot_goal,
    dias: delivery.snapshot_days_per_week,
    mes: delivery.month,
    scope: delivery.snapshot_service_scope,
  };
}

export interface DeliveryFile {
  /** Original basename of the source PDF. */
  filename: string;
  bytes: Uint8Array;
  /** Hex SHA-256 of `bytes` (the stamped output). */
  sha256: string;
  sourceKey: string;
}

export interface DeliveryPackage {
  files: DeliveryFile[];
}

/**
 * Validates the input, selects the month's PDFs and returns stamped copies.
 * All validation (name, email, stamp length, order code, route) happens
 * before any source read. Files are processed one at a time to bound memory.
 */
export async function buildDeliveryPackage(
  source: BasePdfSource,
  input: DeliveryPackageInput,
  stamp: PdfStampFn = stampPdf,
): Promise<DeliveryPackage> {
  const name = normalizeClientName(input.name);
  const email = normalizeSubscriberEmail(input.email);
  // Defensive: rows written before the rule (or by another writer) must not
  // reach the stamper; `stampPdf` re-checks every page with the real code.
  assertSubscriberStampFits(name, email);
  const orderCode = normalizeOrderCode(input.orderCode);
  const keys = selectPackage(
    await source.list(),
    input.objetivo,
    input.dias,
    input.mes,
    input.scope,
  );
  const stampOptions = {
    text: buildStampText(name, email, orderCode),
    subject: buildStampSubject(name, email, orderCode),
    keywords: buildStampKeywords(orderCode),
  };

  const files: DeliveryFile[] = [];
  for (const sourceKey of keys) {
    const bytes = await stamp(await source.get(sourceKey), stampOptions);
    files.push({
      filename: posix.basename(sourceKey),
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sourceKey,
    });
  }
  return { files };
}
