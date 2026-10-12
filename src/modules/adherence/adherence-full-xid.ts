const LOOKUP_STATUS = {
  ELIGIBLE: 'eligible',
  UNKNOWN: 'unknown',
} as const;

const UNKNOWN_REASON = {
  INVALID_FULL_XID: 'invalid_full_xid',
  INVALID_NEXT_FULL_XID: 'invalid_next_full_xid',
  RESERVED_XID: 'reserved_xid',
  NOT_OLDER_THAN_SNAPSHOT: 'not_older_than_snapshot',
  OUTSIDE_RETAINED_WINDOW: 'outside_retained_window',
} as const;

type UnknownReason = (typeof UNKNOWN_REASON)[keyof typeof UNKNOWN_REASON];

export type AdherenceCommitTimestampLookupPreparation =
  | {
      status: typeof LOOKUP_STATUS.ELIGIBLE;
      fullXid: string;
      xid32Text: string;
    }
  | {
      status: typeof LOOKUP_STATUS.UNKNOWN;
      reason: UnknownReason;
    };

const MAX_FULL_XID = 18446744073709551615n;
const XID_MODULUS = 4294967296n;
const HALF_XID_RANGE = 2147483648n;

function parseFullXid(value: unknown): bigint | undefined {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 20 ||
    /[^0-9]/.test(value) ||
    (value.length > 1 && value.startsWith('0'))
  ) {
    return undefined;
  }
  const parsed = BigInt(value);
  return parsed <= MAX_FULL_XID ? parsed : undefined;
}

/**
 * Prepares the 32-bit argument for pg_xact_commit_timestamp(xid), not commit proof.
 * nextFullXid must come from a trusted PostgreSQL current snapshot, not a client.
 * The half-range bound conservatively rejects stale/wrap aliases; it does not
 * guarantee metadata retention. The caller still needs namespace verification,
 * full-ID pg_xact_status(xid8), enabled commit timestamps and retained metadata.
 */
export function prepareAdherenceCommitTimestampLookup(
  fullXid: unknown,
  nextFullXid: unknown,
): AdherenceCommitTimestampLookupPreparation {
  const target = parseFullXid(fullXid);
  if (target === undefined || typeof fullXid !== 'string') {
    return {
      status: LOOKUP_STATUS.UNKNOWN,
      reason: UNKNOWN_REASON.INVALID_FULL_XID,
    };
  }
  const next = parseFullXid(nextFullXid);
  if (next === undefined) {
    return {
      status: LOOKUP_STATUS.UNKNOWN,
      reason: UNKNOWN_REASON.INVALID_NEXT_FULL_XID,
    };
  }
  const xid32 = target % XID_MODULUS;
  if (target < 3n || xid32 < 3n) {
    return {
      status: LOOKUP_STATUS.UNKNOWN,
      reason: UNKNOWN_REASON.RESERVED_XID,
    };
  }
  if (next <= target) {
    return {
      status: LOOKUP_STATUS.UNKNOWN,
      reason: UNKNOWN_REASON.NOT_OLDER_THAN_SNAPSHOT,
    };
  }
  if (next - target >= HALF_XID_RANGE) {
    return {
      status: LOOKUP_STATUS.UNKNOWN,
      reason: UNKNOWN_REASON.OUTSIDE_RETAINED_WINDOW,
    };
  }
  return {
    status: LOOKUP_STATUS.ELIGIBLE,
    fullXid,
    xid32Text: xid32.toString(10),
  };
}
