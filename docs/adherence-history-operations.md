# Publish selected historical adherence days with the owner operator

This **manual, privileged** caller connects the existing origin, cut and prescription SDK. It is not enabled by normal API startup, a public endpoint or a new scheduler. Run it only with explicit permission for the database and selected clients. Implementation/testing does **not** authorize production execution, deployment, migrations or grants. P5/P6 remain cancelled/out of scope.

## Quick path

1. Provision the existing migrations through migration 91 using your separately authorized deployment procedure. Use the actual source/journal/sequence/function owner, not the application's restricted reader role. Do not grant broad privileges to make this command pass.
2. Build the current SDK with the project's existing build procedure (default loader: `dist/src/modules/adherence`). Help needs neither credentials nor a build: `node scripts/adherence-history-operator.cjs --help`.
3. Prepare a JSON array of **1–100 unique UUID client IDs** (maximum 8 KiB). Explicitly select the civil UTC date; there is no profile/current-assignment inference or automatic all-user selection.
4. Set **only** `ADHERENCE_OWNER_DATABASE_URL` through your protected operator environment. Supply host, database, role and password in this URL. No dotenv, `DATABASE_URL`, `PG*` fallback or application initialization is used. Non-loopback hosts require `?sslmode=verify-full`, with certificate validation; the OS/default Node trust store must trust the server certificate. Never put the URL in commands, logs or a checked-in file.
5. Execute read-only preflight, then explicitly authorized `run` shortly before UTC midnight (for example 23:59:30). Replace the illustrative host/database/role/date/file below with the reviewed selection.

```sh
node scripts/adherence-history-operator.cjs preflight --expected-host 127.0.0.1 --expected-database selected_database --expected-role history_owner --date 2026-10-03 --clients-file selected-clients.json

node scripts/adherence-history-operator.cjs run --expected-host 127.0.0.1 --expected-database selected_database --expected-role history_owner --date 2026-10-03 --clients-file selected-clients.json --trust-pg-clock-owner-no-maintenance
```

Preflight checks identity, commit timestamp tracking ON, owner/source objects, migration-91 table and required function privileges in a read-only transaction. It never activates an origin or issues grants. It does not prove the clock's accuracy: the write flag is an explicit acknowledgment of a trusted PG UTC clock, trusted owner and **no privileged DDL, restore or maintenance while live**.

## Bounds and ownership

| Contract | Behavior |
| --- | --- |
| UTC date | Strict `YYYY-MM-DD`; cutoff is the next midnight `YYYY-MM-DDT00:00:00.000000Z`. |
| Activation window | Must start before cutoff and within `--max-wait-seconds` (default 90, range 1–300). Late starts fail before activation; cannot fabricate a past-day proof. |
| Live origin | Session advisory lock `(60309,31)` serializes operators in this database. The checked-out connection transfers to the SDK; no raw queries/releases, reconnection or persistent lease reconstruction thereafter. |
| Waiting | Bounded monotonic deadline and PG-clock polling through the pinned lease keep the backend fence live. SIGINT/SIGTERM cancels cooperatively and awaits lease/pool cleanup. Individual database statements have a 10-second timeout. |
| Cut | SDK owns source locks through commit and checks activation proof at/before cutoff. `--max-transactions` 1–128 (default 128); `--max-statements` 7–4096 (default 4096, includes six reserved framing calls). Overflow/fence failure is UNKNOWN, never partial proof. |
| Publication | Separate checked-out repeatable-read transaction per selected client. Actual SDK validates original source/cut/digests and immutable exact replay. Conflicting original basis is never overwritten. |
| Scheduling | If desired, an external operator/cron may invoke this manual command for an explicitly selected day/scope near midnight, under separate authorization. No scheduler is installed here. |

Output contains only `status`, `reasonCode`, `stored` and `unknown` counts. `ready` means preflight only; `stored` means every selected publication received an acknowledgment. `partial` means some did, others did not; it is not all-PASS. Non-success exits with code 1. Database diagnostics, client IDs, source payloads and credentials are not printed. A lost commit acknowledgment can leave durable work despite UNKNOWN. A thrown publication/transport error stops further writes; unattempted selected clients count as unknown and can be recovered against the original cut.

## Cancel, disconnect and original-cut recovery

Do not rerun `run` for a closed date or revive an old live lease. After cancellation/disconnect/uncertain activation, inspect durable state read-only under the authorized owner. No acknowledged original cut means historical UNKNOWN; a new activation cannot repair the past.

If a durable original cut exists, establish its **exact** epoch/origin/cutoff from the owner's `public.adherence_history_cuts` records using an independently authorized read-only inspection. Match the operation's database and UTC cutoff, verify its provenance, and retain the original selected client file securely. Do not guess or automatically choose the newest cut. If provenance is ambiguous, stop. The operator deliberately does not dump these records or receipt identifiers.

```sh
node scripts/adherence-history-operator.cjs resume --expected-host 127.0.0.1 --expected-database selected_database --expected-role history_owner --date 2026-10-03 --clients-file selected-clients.json --epoch ORIGINAL_EPOCH_UUID --origin ORIGINAL_ORIGIN_UUID --trust-pg-clock-owner-no-maintenance
```

`resume` first calls the SDK's read-only `validateStoredAdherenceHistoryCut` with the original binding. It never activates, looks up XID timestamps, issues a new cut or reconstructs a lease. Only a validated cut can feed publication. Each client/day remains bound to that exact original cut; repeating the same selection accepts exact replay, while conflicts remain unknown. Resume is an explicit write command, not a permission-free repair.

## Verification and limits

- `node --test scripts/adherence-history-operator.spec.cjs`: deterministic gates, UTC, wait/abort, transfer/cleanup, exact publisher binding, partial/conflict/recovery and raw adapter behavior.
- The same command with `EXOM_OPERATOR_PG_TEST=1` additionally checks actual owner preflight, the actual compiled SDK's pinned origin, early-cut rejection and backend loss on a fresh isolated PG17 migrated through all 91 migrations. Test-only `EXOM_OPERATOR_TEST_SDK_ROOT` selects isolated compiled SDK output; production CLI has no loader or clock-spoof environment override. Test fixtures also require `ADHERENCE_OWNER_DATABASE_URL` and `EXOM_OPERATOR_EXPECTED_HOST/DATABASE/ROLE` for the uniquely owned loopback target.
- A real closed-midnight full-pipeline soak is **NOT RUN** in this work unit. Deterministic time orchestration and real SDK continuity tests are distinct layers, not evidence of a real historical positive cut minted today. No production or remote operation was performed.

Before operating: verify owner/TLS/clock, no maintenance, selected date/clients, bounds, deployment permission and an original-cut recovery procedure. Keep privileged receipt inspection separate from count-only operational logs.
