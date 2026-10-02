import {
  resolveAdherenceCommitMetadata,
  type AdherenceCommitRequest,
  type AdherenceCommitSessionProvider,
  type AdherenceCommitSql,
} from './adherence-commit-resolver';

const STATUS = { UNKNOWN: 'unknown', PROOF: 'proof' } as const;
export interface AdherenceCommitProof {
  epoch_id: string;
  origin: string;
  full_xid: string;
  digest_version: number;
  baseline_digest: string;
  event_digest: string;
  content_digest: string;
  proof_digest: string;
  event_count: string;
  activation: boolean;
  timestamp_utc: string;
  microseconds: string;
}
interface ProvenCommit {
  status: typeof STATUS.PROOF;
  proof: AdherenceCommitProof;
  atOrBeforeCutoff: boolean;
}
interface UnknownCommit {
  status: typeof STATUS.UNKNOWN;
}
export type AdherenceCommitEvidence = ProvenCommit | UnknownCommit;
interface EvidenceRow {
  value: unknown;
  atOrBeforeCutoff: boolean | null;
}
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const DIGEST = /^[0-9a-f]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const unknown = (): UnknownCommit => ({ status: STATUS.UNKNOWN });
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function proof(
  value: unknown,
  request: AdherenceCommitRequest,
): value is AdherenceCommitProof {
  return (
    object(value) &&
    Object.keys(value).length === 12 &&
    value.epoch_id === request.epochId &&
    value.origin === request.origin &&
    value.full_xid === request.fullXid &&
    value.digest_version === 1 &&
    typeof value.baseline_digest === 'string' &&
    DIGEST.test(value.baseline_digest) &&
    typeof value.event_digest === 'string' &&
    DIGEST.test(value.event_digest) &&
    typeof value.content_digest === 'string' &&
    DIGEST.test(value.content_digest) &&
    typeof value.proof_digest === 'string' &&
    DIGEST.test(value.proof_digest) &&
    typeof value.event_count === 'string' &&
    DECIMAL.test(value.event_count) &&
    typeof value.activation === 'boolean' &&
    (value.activation || value.event_count !== '0') &&
    typeof value.timestamp_utc === 'string' &&
    STAMP.test(value.timestamp_utc) &&
    typeof value.microseconds === 'string' &&
    /^-?(0|[1-9][0-9]*)$/.test(value.microseconds)
  );
}
async function read(
  sql: AdherenceCommitSql,
  request: AdherenceCommitRequest,
): Promise<EvidenceRow[]> {
  return sql.$queryRaw<EvidenceRow[]>`
    WITH evidence AS MATERIALIZED (
      SELECT public.read_adherence_commit_evidence(
        ${request.epochId}, ${request.origin}, ${request.fullXid}) AS value
    ) SELECT value, CASE WHEN value->>'state' = 'proof'
      THEN (value->'proof'->>'timestamp_utc')::timestamptz <= ${request.cutoffUtc}::timestamptz
      END AS "atOrBeforeCutoff" FROM evidence`;
}
function decode(
  rows: EvidenceRow[],
  request: AdherenceCommitRequest,
): AdherenceCommitEvidence {
  const row = rows[0];
  if (
    rows.length !== 1 ||
    !object(row.value) ||
    row.value.state !== 'proof' ||
    !proof(row.value.proof, request) ||
    typeof row.atOrBeforeCutoff !== 'boolean'
  ) {
    return unknown();
  }
  return {
    status: STATUS.PROOF,
    proof: row.value.proof,
    atOrBeforeCutoff: row.atOrBeforeCutoff,
  };
}

/** Privileged READ ONLY durable proof validation against the ORIGINAL binding.
 * No live-origin verification, snapshot/status/timestamp lookup or issuance fallback.
 * Restores may reuse only exact SQL-validated baseline and BOTH-journal digests.
 */
export async function validateStoredAdherenceCommitEvidence(
  sql: AdherenceCommitSql,
  request: AdherenceCommitRequest,
): Promise<AdherenceCommitEvidence> {
  if (
    !request.epochId ||
    !request.origin ||
    !/^[1-9][0-9]*$/.test(request.fullXid) ||
    BigInt(request.fullXid) > 18446744073709551615n ||
    !STAMP.test(request.cutoffUtc)
  )
    return unknown();
  try {
    return decode(await read(sql, request), request);
  } catch {
    return unknown();
  }
}

/**
 * Owner-only orchestration, deliberately not wired to a runtime endpoint.
 * There is NO default origin provider. Authenticated external authority must
 * hold its fence through the pinned transaction commit, not merely callback
 * return. SQL uniqueness cannot verify that operational authority's correctness.
 * Restored proof reuse validates the original epoch/origin/full payload and
 * never queries restored XID metadata. An unresolved restored XID still requires
 * independent origin continuity; a copied epoch/server identifier is not proof.
 * This proves neither precapture legacy nor the full universe through a cutoff.
 */
export async function persistAdherenceCommitEvidence(
  provider: AdherenceCommitSessionProvider,
  request: AdherenceCommitRequest,
): Promise<AdherenceCommitEvidence> {
  if (
    !request.epochId ||
    !request.origin ||
    !/^[1-9][0-9]*$/.test(request.fullXid) ||
    BigInt(request.fullXid) > 18446744073709551615n ||
    !STAMP.test(request.cutoffUtc)
  ) {
    return unknown();
  }
  try {
    return await provider.withSession(async (session) => {
      if ((await session.verifyOrigin(request)) !== request.origin)
        return unknown();
      const stored = await read(session.sql, request);
      if (
        stored.length !== 1 ||
        !object(stored[0].value) ||
        !['proof', 'missing'].includes(String(stored[0].value.state))
      ) {
        return unknown();
      }
      if (stored[0].value.state === 'proof') {
        if ((await session.verifyOrigin(request)) !== request.origin)
          return unknown();
        return decode(stored, request);
      }
      const bindings = await session.sql.$queryRaw<{ value: unknown }[]>`
        SELECT public.adherence_commit_payload(${request.epochId}, ${request.fullXid}) AS value`;
      if (
        bindings.length !== 1 ||
        !object(bindings[0].value) ||
        typeof bindings[0].value.content_digest !== 'string' ||
        !DIGEST.test(bindings[0].value.content_digest)
      ) {
        return unknown();
      }
      // Adapter deliberately reuses THIS session, never another pool/transaction.
      const pinned: AdherenceCommitSessionProvider = {
        withSession: (work) => work(session),
      };
      const metadata = await resolveAdherenceCommitMetadata(pinned, request);
      if (metadata.status !== 'metadata') return unknown();
      if ((await session.verifyOrigin(request)) !== request.origin)
        return unknown();
      await session.sql.$queryRaw`
        SELECT public.issue_adherence_commit_evidence(${request.epochId}, ${request.origin},
          ${request.fullXid}, ${metadata.timestampUtc}, ${metadata.microseconds},
          ${bindings[0].value.content_digest})`;
      const result = decode(await read(session.sql, request), request);
      // Throw inside the pinned transaction on post-issuance failure so the
      // provider rolls back; do not commit an issuance with a lost fence.
      if (
        result.status !== STATUS.PROOF ||
        (await session.verifyOrigin(request)) !== request.origin
      ) {
        throw new Error('Commit evidence fence or binding lost');
      }
      return result;
    });
  } catch {
    return unknown();
  }
}
