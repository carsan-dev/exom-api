# REST-T2C-1 — manual-task HTTP/module integration

2026-10-05. **Bounded HTTP/module technical verification PASS; native approval exact ACK completed. LOCAL ONLY final checkpoint captured; parent coordination disposition pending.** Adds only the client-scoped Nest HTTP boundary for the existing manual-task service. Parent owns coordination/scoped closure and checkpoint capture; this does not close REST-T2, whole P5, or authorize another unit. This finalization changes documentation only, without new visible documents or source/test/review/resource operations.

## Routes and input contract

Production prefix: `/api/v1`. Base: `/admin/clients/:clientId/follow-up-tasks`, following the existing adherence controller convention.

| Method | Suffix | Contract |
| --- | --- | --- |
| POST | base | Required `id`, `type`, `title`, `due_date`; optional `description`, `priority`, `assigned_to_id`. Returns 201, including identical normalized create replay. |
| GET | `/:taskId` | Read a single task in its client scope. No mutations or materialization. Returns 200. No list route. |
| PUT | `/:taskId` | Required JSON integer `expected_version` (1–2147483647); optional editable fields above except `id`, plus `status`. Returns 200; stale/closed/replay mismatch returns 409. |

Authenticated staff only: actual FirebaseAuthGuard and RolesGuard; ADMIN must remain assigned to the client, SUPER_ADMIN uses existing service scope checks. Owner/creator come exclusively from route/authenticated actor. Client/assignee identifiers retain existing text-ID conventions; create task ID follows the service's UUID regex and lowercase normalization. Reads/updates use the stored task ID without introducing a separate ID canonicalization policy.

Raw input is preserved despite production implicit conversion: numeric text fields and string versions fail rather than being coerced. Optional omission preserves values; only description accepts explicit null. Enum membership and civil YYYY-MM-DD shape are validated in DTOs; the existing service remains authoritative for normalized text lengths (title 1–160, description ≤3000), actual calendar dates (no year zero), eligibility, ownership, replay and optimistic/closed-state rules. Required create fields override inherited optional validation.

Unknown fields, forged owner/creator/version/timestamps, and create status fail with 400. A local pre-pipe interceptor rejects own `__proto__`, `constructor`, and `prototype` keys that framework transformation otherwise removes before whitelist validation. Tests send raw JSON to prevent the HTTP client's object assignment from removing malicious keys before transmission. Completing/cancelling reuses the existing service and introduces no plan/message writers.

## Observed RED → GREEN

- [RED HTTP log](http-f3a62d52-0453-4ea2-9e3b-f1d14beab7a9/jest.log): bootable app with missing module, 46/46 failures on actual missing-route HTTP404 (including expected 401/201/400). Not a missing-import compilation failure.
- [Intermediate log](http-a3947d05-3d99-4591-aedc-95196e6bca5d/jest.log): 45 PASS / 1 FAIL. The client object-send path removed `__proto__`; raw JSON transmission corrected the test seam, without removing the assertion.
- [Initial GREEN](http-a7532f30-3dd5-4fdf-96ba-15870f1f4d6e/jest.log): 46/46 PASS.
- Final tests add a forced PostgreSQL barrier for two HTTP updates, classify exactly one HTTP200 winner and one HTTP409 loser, and compare the persisted version/title to the winner. [Final focused GREEN](http-d8123783-e0e6-4610-ad8c-1ee11f95e390/jest.log): 46/46 PASS, no pending.
- Final full-suite log retains the two contenders' blocker graph: PIDs 249/252 blocked by PID250 before release (second also queued behind 249). This proves the tested version interleaving, not comprehensive production-writer deadlock freedom.
- Manual formatting/type-boundary refinement removed candidate lint errors without disabling rules; failures remain recorded in [validation summary](validation.md).

## Writer verification receipts — preserved chronology

All commands ran foreground. For unit/pg/all, set `FOLLOWUP_EVIDENCE_ROOT=docs/evidence/rest-t2c-20261005` before invocation. This is the explicit current-root selection; legacy default unit/pg/all paths remain T2B-compatible. HTTP defaults to T2C. The runner admits only the two approved roots, uses sanitized child environments, blanks dotenv reads, and writes no T2B artifacts during these runs. ALL sets the HTTP prerequisite flag and verifies a passed, nonempty HTTP suite; no pending tests are accepted.

| Exact command | Observed result / evidence |
| --- | --- |
| `node scripts/run-followup-tasks-integration.cjs http` | PASS 1 suite / 46 tests; [final JSON](http-d8123783-e0e6-4610-ad8c-1ee11f95e390/jest.json) |
| `node scripts/run-followup-tasks-integration.cjs unit` | PASS 1 / 44; [JSON](unit-dcfb41ba-4953-474e-99cf-f3c07f7a3a30/jest.json) |
| `node scripts/run-followup-tasks-integration.cjs pg` | PASS 1 / 12; [JSON](pg-dbd870a6-3be1-4bc5-a86b-caa7186d062f/jest.json) |
| `node scripts/run-followup-tasks-integration.cjs all` | PASS 107 / 1274, zero pending, including all 46 HTTP tests; [log](all-9ac7423d-7e4d-499d-a72a-948ab3d765e4/jest.log), [JSON](all-9ac7423d-7e4d-499d-a72a-948ab3d765e4/jest.json) |
| `npm run lint -- --no-fix` | PASS exit0, zero errors, only two pre-existing progress.concurrency.spec.ts warnings at 474/482; [summary](validation.md) |
| `npm exec -- tsc --project tsconfig.build.json --outDir docs/evidence/rest-t2c-20261005/build --incremental false` | PASS exit0, no diagnostics; nondeleting tsc, not Nest build; [summary](validation.md) |
| `git diff --check` | PASS exit0; scoped new-source trailing-whitespace inspection found no matches |

Lint/tsc used a cleared environment with allowlisted OS variables, NODE_ENV=test, unused loopback database configuration and the retained privacy preload/empty dotenv from initial GREEN. No dependency changes, schema changes, live Firebase calls, production fallback, remote operations, resource deletion or shutdown. Prior Prisma generation/validation PASS remains applicable with unchanged schema/configuration.

## Recovery and preserved work

- [Pre-edit state/document/source hashes](http-before.md).
- [Final tested candidate manifest and snapshot paths](after-all-6efd7e25-a4a7-45c1-bac5-2d1ff33e72e4/manifest.json). All source copies use `.ts.snapshot`, not compilable `.ts`; manifests include the pre-existing untracked service/spec/PGspec/deletion probe and new sources. Snapshot copies plus current HEAD/T2B original checkpoint permit local recovery without a commit.
- Service `a3522bb5…`, original unit spec `8a8c05f8…`, PG spec `9cd76e4e…`, deletion probe `8b5ba61a…` remain unchanged byte-for-byte. Full final hashes are in the manifest. Final controller `56b88817…`, module `dba8ebdf…`, DTO `8deceeaf…`, HTTP spec `7dbf676e…`, runner `289963ff…`.
- 621 new TypeScript source lines plus small runner/registration/ignore edits; slight forecast overrun protects assertions/readability, not expanded product scope.
- Each DB run retains its `resource.json`, migration list and database inventory. SQL/container identity and empty schema were verified before writes. ALL retained container `exom-rest-t2c-399fc5bd-b6d7-4885-8999-33e1fee27de3`, ID `28a0ecb4de5eacf09d3931d09fb97ba800159f527cc45a225b64ad83769706a2`, loopback port57404, role/database `exom_ci`, PGDATA `/var/lib/postgresql/exom-ci-data`. No resources stopped/removed.
- Anchored ignores hide only T2C generated caches/build; authored logs, receipts and snapshots remain visible. Historical T2B snapshots/failures/receipts are not rewritten.

## Limits / review focus

Review controller/module registration, raw-input preservation and mandatory-create inheritance, malicious-key rejection before global pipes, persisted actor/assignee scope and ALL's non-skip assertion. The test app imports the task module selected from AppModule metadata with actual global guards, production validation options, filter and response envelope. It does not boot Firebase/bootstrap/schedulers or exercise ApprovalInterceptor (these new routes are not interceptable approval writers).

REST-T2B-FU-04 now has explicit HTTP winner classification for this tested interleaving. Broader FU-01/02/03/05 remain open: production staff role/archive/assignment/deletion writers, bulk lock ordering, comprehensive operation-specific graphs and populated historical/message fixtures are not implemented or claimed here. Shared projections, list/UI/Admin/App, REST-T3 and P6 remain excluded. Parent owns follow-up dispositions; independent verification and parent-observed native approval are recorded below. No review tools were invoked by this writer.

## Current artifact-visibility policy — local evidence only

The later user-authorized hygiene refinement supersedes the earlier statement that run logs/snapshots remain Git-visible. Maintained Markdown receipts remain visible; per-run logs/JSON/resource inventories, cache/build outputs, intermediate before/after snapshots and local checkpoints under the two named REST-T2B/T2C roots are now ignored. **Every existing byte remains on disk.** No historical execution result was rewritten and no tests/builds or review lifecycle were rerun for this passive change.

Links above to run logs, JSON, resource inventories and checkpoint manifests are **local-checkout trace references**. They remain meaningful in this retained workspace but their targets are not automatically supplied by a fresh Git clone. Ignored recovery snapshots/checkpoints are **LOCAL ONLY**, not clone-portable recovery; a separately preserved archive or authorized delivery of those files is needed for recovery elsewhere. Git ignore is neither deletion nor proof that such an archive has been delivered. Older T2B receipt/checkpoint references have the same local-only boundary; their historical documents were not massmodified.

See [current hygiene refinement](artifact-hygiene.md#current-refinement--local-run-artifacts-and-checkpoints) for precise patterns, counts, hashes and visibility checks. Existing HTTP implementation remains present and untouched; independent verification and native exact ACK have passed, with the LOCAL ONLY final checkpoint now captured and parent coordination disposition pending. This policy update does **not** close whole P5 and does not start further implementation.

## Latest independent verification — PASS

[Readable independent receipt](independent-verification/README.md) records fresh technical PASS: HTTP46 (`http-b795ce3c-e17e-4ce8-ba7f-f871a4c7e111/`), unit44 (`unit-66ae3a03-1426-42e3-8229-f4f35117ffb2/`), PG12 (`pg-b3fb7ee7-5545-4d1b-9b7c-a3c0e6c8c522/`), ALL107 suites/1274 tests with zero pending (`all-3e6bff5e-8ffb-4cad-8f06-978e42b852d7/`), lint and the nondeleting `build-independent` TypeScript check. These are the verifier's executions, not reruns in this documentation correction. Independent source/checkpoint and individual preservation comparisons passed. The independent receipt's native-pending statement is its dated historical state, superseded by the parent-observed completed ACK below; the original receipt is unchanged. The LOCAL ONLY final checkpoint is now captured; parent scoped coordination disposition remains pending.

The latest [hygiene correction](artifact-hygiene.md#independent-verifier-artifact-correction--2026-10-05) excludes the exact new build output and local verifier status/patch/snapshots while retaining this README and the readable independent receipt. Its case-folded component-order explanation reproduces the writer aggregate without overwriting historical values; ordinal-POSIX ordering reproduces the verifier's different value. Local individual comparisons (6722 baseline + 37 final artifact entries, zero mismatches) remain the preservation evidence. Ignored log/JSON/build/snapshot links here remain local-only, not fresh-clone recovery promises. No source/harness edits or final closure occurred in this correction.

## Final scoped technical/native receipt — 2026-10-05

### Exact latest independent checks

These are existing independently observed results, not executions during this passive finalization. Runner commands used `FOLLOWUP_EVIDENCE_ROOT=docs/evidence/rest-t2c-20261005`; trace targets remain LOCAL ONLY under the current ignore policy.

| Exact command | Result | Existing local receipt |
| --- | --- | --- |
| `node scripts/run-followup-tasks-integration.cjs http` | PASS 1 suite / 46 tests, zero pending | [HTTP log](http-b795ce3c-e17e-4ce8-ba7f-f871a4c7e111/jest.log), [JSON](http-b795ce3c-e17e-4ce8-ba7f-f871a4c7e111/jest.json) |
| `node scripts/run-followup-tasks-integration.cjs unit` | PASS 1 / 44, zero pending | [unit log](unit-66ae3a03-1426-42e3-8229-f4f35117ffb2/jest.log), [JSON](unit-66ae3a03-1426-42e3-8229-f4f35117ffb2/jest.json) |
| `node scripts/run-followup-tasks-integration.cjs pg` | PASS 1 / 12, zero pending | [PG log](pg-b3fb7ee7-5545-4d1b-9b7c-a3c0e6c8c522/jest.log), [JSON](pg-b3fb7ee7-5545-4d1b-9b7c-a3c0e6c8c522/jest.json) |
| `node scripts/run-followup-tasks-integration.cjs all` | PASS 107 suites / 1274 tests, zero pending; all HTTP46 assertions passed | [ALL log](all-3e6bff5e-8ffb-4cad-8f06-978e42b852d7/jest.log), [JSON](all-3e6bff5e-8ffb-4cad-8f06-978e42b852d7/jest.json) |
| `npm run lint -- --no-fix` | PASS, zero errors; two unchanged warnings at progress.concurrency.spec.ts:474/482 | [independent lint log](independent-verification/lint.log) |
| `npm exec -- tsc --project tsconfig.build.json --outDir docs/evidence/rest-t2c-20261005/build-independent --incremental false` | PASS exit0, no diagnostics; nondeleting TypeScript alternative, NOT Nest build | [independent build log](independent-verification/build.log) |
| `git diff --check` | PASS | [independent diff log](independent-verification/diff-check.log) |

Prior independent Prisma generation/validate PASS remains applicable with unchanged schema/config/package/lockfile; no new Prisma execution is claimed. [Hash audit](independent-verification/hash-audit.json) preserves current source/writer-copy identity; later ignore-only corrections are explained in the hygiene receipt. Original service/unit/PGspec/deletion probe remain byte-identical to T2B. [Individual preservation audit](independent-verification/t2b-filelevel-preservation.json) confirms 6722 baseline and 37 final artifact entries, zero mismatches. Historical aggregate FAIL and its later case-folded-order clarification remain recorded rather than rewritten.

### Native disposition — exact parent-observed approval ACK

- Lineage: `review-9e916a992b0ea547`.
- Target: `sha256:f7bde221ca8cd99ab7f52d8dd1253b92e5e2ee7a2f29730f0127911cba9154c8`.
- Candidate tree: `071ac136a2fdac1117e832496f0b12c7fc2111c9`.
- Consumed revision: `sha256:8d068f06d790f1d570781f8c426f987cf8c043c6ad06f74ec444dd6cf4b9f580`.
- Exact ACK: `status: closed`, `outcome: native-approved-acknowledgement-completed`, `authority: burned`.
- No advisory findings were emitted for this review. Native selected **10 paths**, including pre-existing untracked service/test dependency code; review coverage is not 2095 newly authored lines. The writer's authored-line estimate above remains a separate measure.

ASSESS is a separate observation: unassessable undeclared-untracked inventory, candidate null, outcome unknown. The independent high-risk fallback had already completed. This does not cancel or supersede the completed exact ACK. No lifecycle rerun or new review invocation occurred in documentation finalization. The independently OPEN T2B `R3-snapshot-collision` harness-hardening advisory remains unchanged; this review's no-advisory result does not close it or expand scope.

### Retained independent resources — receipt identities, not new live inspection

| Run | Retained container name / full ID | Loopback port |
| --- | --- | --- |
| HTTP | `exom-rest-t2c-2a63eed6-a946-4492-b01d-ca496dff2697` / `268ba9fdf518c1f8d3d1fb406f7768abb0f3680e4d86e8485f76270a2bcd3b6b` | 53549 |
| PG | `exom-rest-t2c-6560c312-e8b5-48a7-a0dd-3fe5b716b750` / `515ea02e74acbf772d0ad9050de9a5d3124de737f6a4efde6746706a5c502cbf` | 53768 |
| ALL | `exom-rest-t2c-30f38a47-31bf-49ca-94c7-4c25925216e4` / `5bbffa36121d78f2ce061551bdb9798d9ce6f3aa9b5fc73562654cf8da8ab4ab` | 53777 |

Database/role `exom_ci`, PGDATA `/var/lib/postgresql/exom-ci-data`; ALL retains 12 databases. Each linked run has its local `resource.json`, `migrations.json` and `retained-databases.json`. All historical failures/resources are preserved; no stop/remove/drop/cleanup authorization is implied.

### Limits, parent checkpoint and next proposal

The guarded HTTP/PostgreSQL seam validates this bounded contract; it does not prove frontend behavior, live Firebase cryptography/session transport, full AppModule/bootstrap/scheduler/OpenAPI smoke or deployment. Production writer transactions, bulk deadlock ordering, comprehensive lock graphs and populated historical/message fixtures remain assigned to existing T2B FU-01/02/03/05. HTTP tests explicitly prove exactly one fulfilled HTTP200 winner and HTTP409 loser with persisted winner/version for the tested FU-04 interleaving; this does not retroactively rewrite T2B's narrower evidence.

**Final checkpoint captured and structurally verified:** LOCAL ONLY [checkpoint/final/manifest.json](checkpoint/final/manifest.json), within the already ignored checkpoint directory. Safe pre-finalization snapshots, current source hashes, three-repository state, patches, retained-resource receipt index and recovery instructions are preserved. Parent coordination task REST-T2C-2 remains IN_PROGRESS until its separate status update; this checkpoint does not claim that update already occurred. Existing writer/independent snapshots support retained-workspace recovery. A fresh clone does not include ignored traces or recovery snapshots; separate archive/delivery is required and is not claimed here. Parent owns final documentation/coordination capture and scoped disposition.

**Next proposed bounded unit:** reconcile the plan, then scope a shared query/list/projection contract for manual tasks. It is NOT started or automatically authorized by this receipt. No shared projections, UI/Admin/App, REST-T3, P6 or whole-P5 closure is claimed. No commits/staging, remote actions, resource operations or additional implementation were performed in this finalization.

## Final checkpoint structural receipt — 2026-10-05

[Checkpoint verification](checkpoint/final/verification-receipt.md) and [non-destructive recovery](checkpoint/final/RECOVERY.md) identify the retained LOCAL ONLY artifacts. Source/config/doc snapshots were captured before this README refresh, preserving prior wording rather than overwriting those snapshots. This checkpoint-capture statement supersedes the pre-capture planned/pending checkpoint wording in validation.md and earlier dated sections; it does not change their historical command results. Native-pending statements in the dated pre-ACK hygiene correction and original independent report are historical, explicitly superseded by the exact parent-observed ACK above. No native lifecycle was invoked again.

Current plan/AGENTS criteria remain unchanged; original failures/resources and OPEN follow-ups are preserved. Parent will finalize REST-T2C-2 only after this structural PASS and then refresh the task snapshot/hash. No tests/builds, application/config/harness edits, resource writes, deletion, staging or commits occurred during checkpoint capture. Git-visible count remains 20; checkpoint output is ignored but physically retained, not fresh-clone archival.
