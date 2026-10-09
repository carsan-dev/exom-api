# REST-T2B — final scoped local receipt

> Copia saneada para entrega: ubicaciones normalizadas; resultados, fechas y hashes conservan su significado histórico y corresponden al snapshot privado original, no a esta copia. WORKSPACE_ROOT identifica la coordinación; SDK_ROOT el SDK instalado; RUNTIME_ROOT las herramientas locales; TEST_ARTIFACT_ROOT los recursos privados retenidos, no publicados.


2026-10-05. **Bounded internal manual-task service validation PASS; native approval acknowledgement completed.** This receipt consolidates the verified source candidate, not full REST-T2/P5 closure, deployment or authorization to start another unit. This finalization changed documentation only: no source/harness edits, test reruns, review lifecycle reruns, staging, commits, cleanup or remote actions.

## Review path and scope

1. Read [corrected independent verification](independent-verification/corrected-candidate.md) for fresh command results and coverage limits.
2. Check [corrected hash audit](independent-verification/corrected-hash-audit.json) against [verified writer checkpoint](after-all-f95da048-9666-4283-8e0d-ed2e4446a3c4/manifest.json); follow `snapshot_paths` to preserved copies.
3. Use the follow-up table below when authorizing HTTP/integration/full-P5 acceptance; do not treat this receipt as proof of those broader guarantees.

Selected behavior: internal create/get/update, persisted authorization and explicit assignee checks, owner isolation, expected-version conflicts, closed immutability/overflow, same-payload create replay and conflicting payload/creator/owner handling. Existing service and its original spec were preserved; no deterministic service defect was demonstrated. Added real PostgreSQL service coverage and an isolated retained-resource harness. Completing/cancelling a task invokes no plan/message side effects in this service.

Excluded: HTTP/controller/module integration, shared projections, Admin/App/UI, REST-T3, P6 and overall P5 acceptance. Criteria are unchanged.

## Candidate and recoverability

API root `${WORKSPACE_ROOT}/exom-api`; branch/upstream `feat/progreso-adherencia-p4` / `origin/feat/progreso-adherencia-p4`; HEAD `c383d47f4aa8217f727acf33e4c1900c0866b7bd`. The intended untracked candidate—not HEAD alone—is the reviewed unit. No tracked/staged changes; original untracked work retained. Coordination root is non-Git; parent captures its final documentation separately.

| Selected path | Verified SHA256 |
| --- | --- |
| `src/modules/client-followup-tasks/client-followup-tasks.service.ts` | `a3522bb55c67f372b8dccbae9f8ac26ec875e331e01619933110a28284cd1d67` |
| `src/modules/client-followup-tasks/client-followup-tasks.service.spec.ts` | `8a8c05f822e948c51e240ba7e8735a4069175c03457df8da2bd695248437a8e7` |
| `src/modules/client-followup-tasks/client-followup-tasks.pg.spec.ts` | `9cd76e4e88c853bd8fa679e6307f30e1378e075ef22eed4ce8778656807f8dd5` |
| `scripts/run-followup-tasks-integration.cjs` | `fe5268ca50fb78a22fb3fd918bdf3551013241aa871e15fd3d30f49a954f251c` |

Original service/spec and `scripts/probe-client-deletion-lock-order.cjs` match [before manifest](before/manifest.json) and preserved originals. Probe SHA256 remains `8b5ba61a1cf147c643727dbfb2f7139126e6f08647906bb7cf5ad9004ddc8ac4`; it was not executed.

Independent audit PASS: 888 rename-inventory entries, 77 checkpoint entries, all 906 `.ts.snapshot` files covered; zero missing, mismatched or uncovered snapshots. Both rename inventories and all historical copies/logs remain retrievable. Future checkpoints use noncompilable suffixes. Fresh declarations in `final-independent-build/` are expected build outputs, not checkpoint source copies; no documentation-finalization renames or cleanup occurred.

## Exact verification commands and receipts

Results below are the verifier's observed evidence, **not executions in this documentation pass**. Paths are relative to this directory.

| Exact command | Result | Receipt |
| --- | --- | --- |
| `node scripts/run-followup-tasks-integration.cjs unit` | PASS, 1 suite / 44 tests, zero pending | `unit-acf0bd37-54e6-4abe-bee1-f73373079491/jest.log`, `jest.json` |
| `node scripts/run-followup-tasks-integration.cjs pg` | PASS, 1 suite / 12 tests, zero pending | `pg-9e745ee4-9f53-48ff-940c-96ba4744e111/jest.log`, `jest.json`, resource/migrations/inventory receipts |
| `node scripts/run-followup-tasks-integration.cjs all` | PASS, 106 suites / 1228 tests, zero pending | `all-db49d3c4-8575-4a05-83ca-1b43605ee1f4/jest.log`, `jest.json`, resource/migrations/inventory receipts |
| `npm run lint -- --no-fix` | PASS, exit 0; zero errors, two unchanged warnings at progress.concurrency.spec.ts:474/482 | `independent-verification/corrected-independent-lint.log` |
| `npm exec -- tsc --project tsconfig.build.json --outDir docs/evidence/rest-t2b-20261005/final-independent-build --incremental false` | PASS, exit 0, no diagnostics; nondeleting TypeScript build, **not Nest build** | `independent-verification/final-independent-build.log` |
| `npm run prisma:generate` | Prior independent PASS, Prisma client 7.10.0; no correction repeat needed with unchanged schema/config | `independent-verification/prisma-generate.log`, [prior report](independent-verification/README.md) |
| `npm exec -- prisma validate` | Prior independent PASS, valid schema; no correction repeat needed with unchanged schema/config | `independent-verification/prisma-validate.log`, [prior report](independent-verification/README.md) |

`npm run build` remains NOT_RUN/prohibited because its configured deletion was not authorized. The approved nondeleting TypeScript check passed; this does not claim execution of Nest build. No UI validation applies to this non-UI unit.

Safety: sanitized child environments, blank dotenv/privacy preload, fresh random owned PostgreSQL resources, exact container/SQL identities and empty schema verified before writes; no production fallback. Prisma/lint/build used isolated safe configuration without exposing dotenv credentials. Existing suite fixture operations occurred only in owned disposable resources.

### Preserved failure history

Initial harness quoting/prerequisite failures and formatting failures remain dated failures, not retrospectively PASS. `REST-T2B-VERIFY-BUILD-01` is RESOLVED for this corrected candidate: checkpoint copies caused 33 TS2307 errors; observed RED preceded the suffix/hash-preserving correction, then writer and independent fresh tsc GREEN. No compiler exclusions or service changes masked it. Service RED/GREEN exception remains validation-only, not an invented service bug fix.

Initial native unassessable/blocked attempts remain history. Parent reports they were resolved through intended-untracked selection. No lifecycle was rerun during this documentation pass.

## Native disposition — parent-provided completed lifecycle

This records the parent's supplied result; the writer neither invokes nor substitutes for native review.

- Lineage: `review-b8a48996024e9dec`.
- Target: `sha256:8dcf441ce0bf85d3311fa2726dc7238bcb8a71092b2629639656f5cb0099832c`.
- Selected paths: the four service/service.spec/pg.spec/harness paths in the candidate table.
- Candidate tree: `d5b498e29af0ee9bff1de9c8acff729e777e794e`.
- Exact approval ACK returned `status: closed`, `outcome: native-approved-acknowledgement-completed`, `authority: burned`.
- Consumed revision: `sha256:4fa7244ffde74387e47ef64dd34dea440d0bae08db45b066214d49130f1c2315`.

Only informational advisory: `R3-snapshot-collision`, `scripts/run-followup-tasks-integration.cjs:35-39`, severity WARNING. Native explicitly marked it nonblocking with no correction. No unprovided finding details are inferred.

## Bounded follow-ups — OPEN, explicitly owned

These coverage limits do not demonstrate a new internal-unit defect and do not weaken P5 criteria. They must be addressed by their named later acceptance scope, not hidden as unspecified debt.

| ID / status | Owner / destination | Reason and concrete acceptance |
| --- | --- | --- |
| `R3-snapshot-collision` — OPEN, native nonblocking | Later harness-hardening unit | Examine collision behavior at the cited lines; add regression coverage preventing accidental checkpoint overwrite while preserving existing bytes/manifests. No finding mechanism beyond the supplied advisory is asserted. |
| `REST-T2B-FU-01` — OPEN | Next HTTP/integration unit | Current races use raw SQL, not complete production writer transactions. Invoke applicable production role/archive/assignment/deletion-request paths against the service in owned realPG resources; force waits and verify post-lock authorization and retained task state. No external identity effects or deletion cleanup without separate authorization. |
| `REST-T2B-FU-02` — OPEN | HTTP/integration concurrency acceptance before full-P5 closure | Multi-row unsorted bulk-assignment deadlock freedom is unproved. Exercise opposing multi-row bulk transactions with the task service; establish/review common lock ordering and assert transaction outcomes, rollback/retry integrity and absence of the tested deadlock interleavings. Do not claim universal freedom from a single case. |
| `REST-T2B-FU-03` — OPEN | Next HTTP/integration test evidence | Wait-count barriers do not retain operation-specific lock graphs. Identify each contender/backend/query; capture its blockers before release and map the retained graph to the intended operation and assertions. |
| `REST-T2B-FU-04` — OPEN | Next HTTP/integration optimistic-version tests | Existing test proves one conflict and persisted version 2 but lacks explicit fulfilled-winner classification. Assert exactly one fulfilled service result and one ConflictException; match winner result/version/payload to the persisted row and prove loser caused no mutation. |
| `REST-T2B-FU-05` — OPEN | Full-P5 populated-history/integration acceptance | Most protected-history tables are empty in no-side-effects snapshots (metric populated). Seed representative nonempty historical, plan and message/outbox fixtures; prove completion/cancellation and relevant later integration preserve their contents/ownership. Link applicable migration/legacy recovery evidence separately; empty-table snapshots are not comprehensive retention proof. |

## Retained resources and next proposal

No resource disposal is authorized. Prior writer/verifier resources and logs remain preserved. Latest independent resources:

- PG: `exom-rest-t2b-247b0ded-5995-4e32-9e3b-0e6260c26290`, ID `80bd3e1e456cc61e6d0d72cc6ecb172aabbfc6dfa04194f228b4d3fedddadb75`, loopback port 56875.
- ALL: `exom-rest-t2b-3f1e0f41-864a-4aea-9da9-e85f40ea081c`, ID `96bea0f4a87ca2135be1de4a34df68e06984b61fbd9eb07768288ad5e5e27431`, loopback port 49540.
- Both database/role `exom_ci`, PGDATA `/var/lib/postgresql/exom-ci-data`. Full inventory retains 12 databases, including the template and nine owned legacy clones; see linked run receipts. No current live-resource reinspection is claimed by this documentation pass.

**Next proposed unit, not started:** authorized HTTP contracts/controller/module integration for manual internal tasks, with its own exact surfaces, tests and the assigned integration follow-ups. Shared projections/Admin and full-P5 acceptance remain separate pending scope. This receipt neither starts that proposal nor closes whole P5; parent owns coordination final state and checkpoint capture.
