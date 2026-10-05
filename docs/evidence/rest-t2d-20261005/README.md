# REST-T2D — canonical next-task / next-review projection

> Copia saneada para entrega: ubicaciones normalizadas; resultados, fechas y hashes conservan su significado histórico y corresponden al snapshot privado original, no a esta copia. WORKSPACE_ROOT identifica la coordinación; SDK_ROOT el SDK instalado; RUNTIME_ROOT las herramientas locales; TEST_ARTIFACT_ROOT los recursos privados retenidos, no publicados.


2026-10-05. **Bounded technical verification PASS; native exact approval ACK completed. Parent-owned local Spanish commit/scoped disposition pending.** Adds only a reusable, staff-authorized per-client read projection. No list, Admin UI, Seguimiento/Dashboard consumer, recap lifecycle, App access, schema change or whole-P5 closure. This finalization edits only this existing README; no tests/source/harness/ignore edits, staging/commits, review reruns, publication, remote/resource operations or next-unit start.

## Contract and review path

`GET /api/v1/admin/clients/:clientId/follow-up-tasks/summary`, registered before `/:taskId`. Existing response envelope: `data` contains `{ as_of_date, next_task, next_review }`.

Each non-null selector contains exactly `id`, `type`, `title`, civil `due_date` (`YYYY-MM-DD`), `priority`, nullable `assigned_to_id`, `version`, and boolean `overdue`. Empty selectors are independently null. No descriptions, creator/owner identifiers, internal notes or staff personal data are returned.

| Invariant | Implementation / evidence |
| --- | --- |
| OPEN means PENDING or IN_PROGRESS | Both SQL selectors exclude COMPLETED/CANCELLED. |
| Next task | First OPEN task of any type. |
| Next review | Independently selected first OPEN REVIEW, not derived from next_task. |
| Order | due_date ASC, explicit CASE HIGH > MEDIUM > LOW, oldest created_at ASC, id ASC. Creation/id tie-break is the parent's selected technical policy. |
| UTC today | Service captures `formatDateOnly(new Date())` once before its transaction; due_date strictly before as_of_date is overdue. Due today and future are not late. |
| Clock/owner input | Query/body clock and owner values are ignored, never passed to service. Route/authenticated actor and server UTC clock are authoritative. |
| Database bounds/coherence | One parameterized UNION ALL statement with LIMIT 1 on each independent selector; at most two selected rows in one PostgreSQL statement snapshot. No all-task load, in-memory sorting or per-task fanout. Limits bound returned rows, not an O(1) scanned-row promise. |
| Authorization | Existing service scope, advisory/user/assignment locks and ReadCommitted transaction options reused unchanged. Assigned ADMIN / SUPER_ADMIN only; no hidden assignee-only filter. Old/inactive assignees and null assignees remain visible. Inactive client historical reads retain the existing contract. |
| Revocation | Real-PG tests force summary to wait on persisted role/assignment revocation and observe denial after commit. HTTP keeps existing guards: inactive staff returns 401, client role/unassigned staff returns 403. |
| Read-only | No writes/materialization/external calls. Populated tasks/metric fixtures plus user/assignment snapshots unchanged across repeated reads. This is not comprehensive historical-fixture coverage. |
| Reusable source | `ClientFollowUpTasksService.summary(clientId, actor)`, exported through its existing Nest module for future authorized staff consumers. Raw query helper is internal, not an authorization entry point. |

Review `client-followup-tasks.queries.ts` first, then service `summary`, static controller route, module export and regression tests. Existing create/update/get behavior and DTO/auth implementation are preserved; the transaction helper is generalized only to return the projection type.

## Observed RED → GREEN and retained failures

Effective strict TDD: explicitly required by parent; runner is the retained isolated-resource harness.

- [Missing-behavior RED](http-fff4c987-44a4-47be-afeb-0fe1cc08a26b/jest.log): 46 prior tests PASS, 2 new tests FAIL with expected 200 / actual 404 because `summary` fell through to `:taskId`. Bootable HTTP app, real guards and real PostgreSQL, not a compile/import failure.
- [Intermediate HTTP](http-68b4ce73-fb36-468e-a724-6edbc1218548/jest.log): 48 PASS / 1 FAIL. The new inactive-account assertion expected 403, but existing FirebaseAuthGuard correctly returns 401. Assertion corrected to the existing guard contract; no production authorization relaxation.
- [Initial GREEN](http-505b4700-a24f-46b2-a92d-baf0bf32d793/jest.log): 49/49 PASS.
- Initial unit45 / PG22 PASS; final PG24 includes two forced summary revocation interleavings. UTC controlled clocks cover offset timestamps immediately before/at UTC midnight, future/due-today/past. Pairwise CALL and REVIEW fixtures protect date, all priority ranks, creation and id ties. Same/independent selectors, closed/empty/cross-owner, old/null assignees, staff eligibility/role/assignment scope and populated-history preservation covered.
- Lint chronology: initial 110 errors (109 formatting plus one unused selector binding), then 4 formatting errors, then zero errors. Changes were manually formatted; projection mapping now explicitly allowlists each returned field. No lint disable, auto-fix or weakened assertion. Historical failures remain failures.

## Final exact validation

All runner commands set the explicit current evidence root and execute foreground. The runner uses allowlisted OS environment, blanks dotenv reads through its retained privacy preload, verifies owned Docker/SQL identity and empty schemas before fixture writes, and retains every resource. Legacy T2B/T2C roots/default modes remain accepted. ALL and PG require passed, nonempty real-PG projection coverage; ALL additionally requires HTTP coverage and zero pending tests.

| Exact command | Observed final result / local trace |
| --- | --- |
| `FOLLOWUP_EVIDENCE_ROOT=docs/evidence/rest-t2d-20261005 node scripts/run-followup-tasks-integration.cjs http` | PASS 1 suite / 49 tests, zero pending; [log](http-daec1882-e4db-4455-802a-8ab104ca156a/jest.log) |
| `FOLLOWUP_EVIDENCE_ROOT=docs/evidence/rest-t2d-20261005 node scripts/run-followup-tasks-integration.cjs unit` | PASS 2 / 45, zero pending; [log](unit-9ed8f1ed-9051-40b4-9010-698fb49bbf55/jest.log) |
| `FOLLOWUP_EVIDENCE_ROOT=docs/evidence/rest-t2d-20261005 node scripts/run-followup-tasks-integration.cjs pg` | PASS 2 / 24, zero pending; [log](pg-9642b800-2395-4b4a-a2ae-c00abc836b72/jest.log) |
| `FOLLOWUP_EVIDENCE_ROOT=docs/evidence/rest-t2d-20261005 node scripts/run-followup-tasks-integration.cjs all` | PASS 108 suites / 1289 tests, zero pending; [log](all-ad6cce1a-4526-4965-92ab-abaa8102d728/jest.log) |
| `npm run lint -- --no-fix` under exact sanitized prefix below | PASS exit0, zero errors, two unchanged warnings in progress.concurrency.spec.ts:474/482 |
| `npm exec -- tsc --project tsconfig.build.json --outDir docs/evidence/rest-t2d-20261005/build --incremental false` under same prefix | PASS exit0, no diagnostics; nondeleting output, not Nest build |
| `git diff --check` | PASS exit0 |

Exact sanitized prefix used separately before each npm command above (append the command to this prefix; this is not a new script):

```bash
env -i PATH="$PATH" SystemRoot="$SYSTEMROOT" WINDIR="$WINDIR" COMSPEC="$COMSPEC" PATHEXT="$PATHEXT" TEMP="$TEMP" TMP="$TMP" NODE_ENV=test DOTENV_CONFIG_PATH=docs/evidence/rest-t2d-20261005/http-505b4700-a24f-46b2-a92d-baf0bf32d793/empty.env NODE_OPTIONS='--require=./docs/evidence/rest-t2d-20261005/http-505b4700-a24f-46b2-a92d-baf0bf32d793/privacy.cjs' DATABASE_URL=postgresql://unused:unused@127.0.0.1:1/exom_ci PRISMA_DATABASE_URL=postgresql://unused:unused@127.0.0.1:1/exom_ci
```

No dependencies, schema, migrations or generated Prisma source changed; prior Prisma validation evidence remains applicable, not newly executed here. No raw Nest build/deleteOutDir invocation.

## Source identity and recovery

API root `${WORKSPACE_ROOT}/exom-api`; verified initial branch `feat/progreso-adherencia-p4`, upstream `origin/feat/progreso-adherencia-p4`, HEAD/base `9161c48c000fd2c88f4bb26b1666136cd9bc521d`, empty tracked/index changes, only unrelated untracked `scripts/probe-client-deletion-lock-order.cjs` (preserved). Coordination root is its parent `.../EXOM`, non-Git; applicable document hashes recorded by the pre-behavior runner snapshot. Only API is edited; Admin/App are not consumers implemented here.

[Final tested source manifest](after-all-582a06d7-501c-4b53-9920-941c1468a940/manifest.json), captured 2026-10-05T14:52:06.411Z, includes full SHA256 and `.ts.snapshot` recovery copies. Post-validation SHA256 inspection matches all eight changed source/config files and the original deletion probe; no behavior edits after validation.

| File (task-module filenames abbreviated) | Final SHA256 |
| --- | --- |
| service.ts | `2e824123fe2390efafbcb7f36b1606af7336861d32783ee4fa5e1ad1b158d0b1` |
| queries.ts | `324ebd81ab274fa272290d84378c01d2a722d85ff920ca9a2afbd9fcf1398e46` |
| controller.ts | `d73e40ad196af69f93637bf5662004f60f098ce11137a03465e6f42077d019b9` |
| module.ts | `c97f961e2d96bd63a26a6a315233f31605efa4ce54cf77cd118c0002f480fe0b` |
| projection.spec.ts | `b5c172cf4103ad33d1d07a057c46f2f72f9535e15104d69e886ab4a1e94847bd` |
| http.spec.ts | `ea17ebf3f8da699e04325b3c3bc3892024ea73349aeb2975caac55233155202a` |
| scripts/run-followup-tasks-integration.cjs | `156b4ce6d50af74fe6190ca71b49ab0742edb1247171a958380064e496b56b1f` |
| .gitignore | `78509ab8edd68c87b41611f4896e77f689d8b25ab117226c4171faece610b15a` |

Coordination SHA256: AGENTS `f21dc8259e9ff8b7a02122efd9b1651a4a22859081c6871722b099c8476a38db`; plan `8322fb624e1c0e54c51c071c7e90a1a2bdd957c9c33374274c80afb78eb2db16`; current task `9b283bb080111f3f7082b5827e80d3993ec471068eba4f49db4e7ee553bf35a2`. These are dated document snapshots, not coordination commits. Plan/task remain parent-owned and unchanged.

[Safe checkpoint/recovery instructions](checkpoint/RECOVERY.md) retain scoped tracked patch and source snapshots, including new files; source snapshots are not compilable `.ts`. The `before` manifest is after test/harness/ignore preparation, before behavior implementation, not pristine HEAD. Anchored ignores were applied before runs and cover only T2D run/cache/build/before/after/checkpoint output; this maintained README stays visible. No whole-root doc/source ignore, deletion or movement.

**LOCAL ONLY:** linked ignored logs/JSON/source snapshots/checkpoints are available in this retained checkout, not delivered by a fresh clone. Separate archival is required for recovery elsewhere and is not claimed.

## Retained resources / limits

Each DB run keeps `resource.json`, `migrations.json`, `retained-databases.json`; credentials are not persisted in these receipts. Final resources below were identity-verified before writes and again at runner completion. Role/database `exom_ci`, PGDATA `/var/lib/postgresql/exom-ci-data`, loopback-only published ports, tmpfs-only data, no host data binds. ALL retains its isolated legacy/history databases.

| Final run | Container / full ID | Port |
| --- | --- | --- |
| HTTP | `exom-rest-t2d-dbc64699-2609-4707-b691-aec9e60df8de` / `895ad39dee0deef37ed402f5b4f800dbc7ebb2bc284f0b467efa13cc12e38e46` | 63342 |
| PG | `exom-rest-t2d-0e714384-e64e-46a8-b6d9-b86d42925902` / `587fb4ae432c60bbc63b0ba564c550cf58b5e1603da88d710102ab377f078d60` | 63308 |
| ALL | `exom-rest-t2d-4c64fcaa-c7c0-4462-89b0-c6fb4c65dc2f` / `9d6669407ebe8bc74a4478b22d78042a4191fb07569c7a0cf25231b90b471428` | 63591 |

Earlier resources are also retained: [RED](http-fff4c987-44a4-47be-afeb-0fe1cc08a26b/resource.json), [intermediate HTTP](http-68b4ce73-fb36-468e-a724-6edbc1218548/resource.json), [initial GREEN](http-505b4700-a24f-46b2-a92d-baf0bf32d793/resource.json), [initial PG](pg-bb112295-2f12-4d40-8695-730f43c73a92/resource.json). No stop/remove/drop/cleanup performed, and old T2B/T2C resources untouched.

Limits: tests exercise actual Nest guards with synthetic Firebase identity verification, not live Firebase, full bootstrap/schedulers/deployment or frontend/mobile. Forced raw SQL revocations demonstrate inherited lock semantics for these cases, not complete production/bulk writer deadlock coverage. Populated metric/task preservation is not all historical-fixture coverage; existing broader T2B follow-ups remain unchanged. Canonical projection is ready for separately scoped consumers; general list/Admin, REST-T3 and P6 are not started. Parent owns review, coordination and any local Spanish commit.

## Independent REST-T2D verification — PASS (2026-10-05)

Bounded technical PASS, not unit DONE/native approval/whole-P5 closure. Parent owns review/disposition/local commits. No verifier source/harness/config/task edits, commits, remote/native/resource-cleanup operations.

### Fresh exact checks
All runner commands used FOLLOWUP_EVIDENCE_ROOT=docs/evidence/rest-t2d-20261005.
- PASS node scripts/run-followup-tasks-integration.cjs http — 1 suites/49 tests, pending0; http-7ec95243-145a-4564-a871-c4c027c8280b/jest.log + jest.json.
- PASS node scripts/run-followup-tasks-integration.cjs unit — 2 suites/45 tests, pending0; unit-7d796732-0be7-4649-881a-ad05ce0918cd/jest.log + jest.json.
- PASS node scripts/run-followup-tasks-integration.cjs pg — 2 suites/24 tests, pending0; pg-502bba95-024a-4436-bc85-0c858675cb02/jest.log + jest.json.
- PASS node scripts/run-followup-tasks-integration.cjs all — 108 suites/1289 tests, pending0; all-c3539f25-c412-49a5-820a-c96520c96ef8/jest.log + jest.json.
JSON checked: unit projection1 structural; PG/ALL projection12 passed assertions (1 structural+11 realPG); ALL HTTP49 passed. No pending.
- PASS npm run lint -- --no-fix — zeroerrors/two unchanged warnings474/482; checkpoint/independent/lint.log.
- PASS npm exec -- tsc --project tsconfig.build.json --outDir docs/evidence/rest-t2d-20261005/build/independent --incremental false — exit0/no diagnostics; checkpoint/independent/build.log. Authorized fallback: build-independent not ignored; git check-ignore verified build/independent BEFORE generation. Nondeleting TypeScript alternative, NOT Nest build.
- PASS git diff --check — checkpoint/independent/diff-check.log. Index empty; tracked.patch plus new-file snapshots recover complete candidate.
Lint/build cleared application environment, OS/path keys only, NODE_ENV=test, fresh HTTP privacy preload/empty.env and explicit unused localhost port1 URLs. Runner uses sanitized fresh labelled clusters with mount/loopback/container/SQL/empty-schema checks before writes, owned legacy84/timestamp-off ALL prerequisites; no production/dotenv/liveFirebase fallback. Prisma/Nest/native/UI/P6 NOT_RUN; schema/config/dependencies unchanged, prior PrismaPASS applicable.
Initial long receipt-writing wrapper SyntaxError occurred before writes; shorter retry used. No test/source correction.

### Independent audit
CodeGraph root/index/query preceded scoped source/diff reads; query returned no current symbol, so exact files inspected. One parameterized UNION ALL statement binds owner twice and independently selects OPEN alltypes task and OPEN REVIEW, each LIMIT1. dueASC, CASE HIGH0/MEDIUM1/LOW2, createdASC/idASC exactly implement selected policy. One PostgreSQL statement snapshot provides coherent selectors; no all-task memory sort/fanout. Return<=2 is not O(1) scanned-row guarantee.
Service captures UTC civil clock once before transaction and compares due<asof; maps fields explicitly (no description/creator/owner/staff personal data). summary static route precedes :taskId; query/body clocks/owners ignored. Actual staff guards/roles and unchanged scope locks revalidate persisted actor/assignment. No assignee filter; old/null/inactive assignees visible. Existing inactive-client historical reads retained; CLIENT/unassignedADMIN403, inactive staff401, missingclient404 covered. No GET writes/materialization/external effects.
Diff preserves get/create/update bodies and DTO/auth; original regressions pass. Module exports existing authorized service; raw helper is not an HTTP authorization entrypoint.
Pairwise CALL/REVIEW fixtures cover due/all priority ranks/created/id keys; same/independent/empty/closed/cross-owner selectors, old/null assignees, frozen offset timestamps before/at UTC midnight, future/today/past overdue. Forced role/assignment revocations prove actual pg_blocking_pids wait before commit and denial afterward. Populated task/metric/user/assignment and HTTP task/metric snapshots unchanged.
Limits: raw revocations, not full production/bulk writer or universal deadlock coverage; no separately forced concurrent direct-task-writer snapshot test or request waiting across midnight. Token-verification seam preserves real guards/persisted identity but not liveFirebase/fullbootstrap/schedulers/OpenAPI/frontend/deployment proof. Representative history fixtures are not comprehensive message/plan preservation. No Dashboard/Seguimiento consumer or P5-04 equality claim.

### Candidate identity
checkpoint/independent/hash-audit.json: all13 live source/config files+writer copies and coordination hashes match after-all-582a06d7-501c-4b53-9920-941c1468a940. Safe .snapshot copies under checkpoint/independent/snapshots; original unit/PGspec/deletionprobe byte-identical.
- src/modules/client-followup-tasks/client-followup-tasks.service.ts SHA256 2e824123fe2390efafbcb7f36b1606af7336861d32783ee4fa5e1ad1b158d0b1
- src/modules/client-followup-tasks/client-followup-tasks.service.spec.ts SHA256 8a8c05f822e948c51e240ba7e8735a4069175c03457df8da2bd695248437a8e7
- scripts/probe-client-deletion-lock-order.cjs SHA256 8b5ba61a1cf147c643727dbfb2f7139126e6f08647906bb7cf5ad9004ddc8ac4
- scripts/run-followup-tasks-integration.cjs SHA256 156b4ce6d50af74fe6190ca71b49ab0742edb1247171a958380064e496b56b1f
- src/modules/client-followup-tasks/client-followup-tasks.pg.spec.ts SHA256 9cd76e4e88c853bd8fa679e6307f30e1378e075ef22eed4ce8778656807f8dd5
- src/modules/client-followup-tasks/client-followup-tasks.queries.ts SHA256 324ebd81ab274fa272290d84378c01d2a722d85ff920ca9a2afbd9fcf1398e46
- src/modules/client-followup-tasks/client-followup-tasks.projection.spec.ts SHA256 b5c172cf4103ad33d1d07a057c46f2f72f9535e15104d69e886ab4a1e94847bd
- .gitignore SHA256 78509ab8edd68c87b41611f4896e77f689d8b25ab117226c4171faece610b15a
- src/app.module.ts SHA256 10776922367082f63a33348839d042d67779f875bc8e680c942a3e90cc0138a0
- src/modules/client-followup-tasks/client-followup-tasks.controller.ts SHA256 d73e40ad196af69f93637bf5662004f60f098ce11137a03465e6f42077d019b9
- src/modules/client-followup-tasks/client-followup-tasks.module.ts SHA256 c97f961e2d96bd63a26a6a315233f31605efa4ce54cf77cd118c0002f480fe0b
- src/modules/client-followup-tasks/client-followup-tasks.http.spec.ts SHA256 ea17ebf3f8da699e04325b3c3bc3892024ea73349aeb2975caac55233155202a
- src/modules/client-followup-tasks/dto/client-followup-task.dto.ts SHA256 8deceeafa82173e4dcf2f692f76b8f810fe50637cf8df9e18da71bf9150bcdbf

### Retained new resources
- http-7ec95243-145a-4564-a871-c4c027c8280b: exom-rest-t2d-5cf0bcb0-9020-4514-b702-5d98678a6084 ID fafc2904be5df69430f6b89893bdafa3f93971e7d05786baa74873f7faf202f8 loopback54036; resource.json/migrations.json/retained-databases.json.
- pg-502bba95-024a-4436-bc85-0c858675cb02: exom-rest-t2d-633cf72f-c3f8-4c8b-a5ff-5b1a599feeb2 ID 9561ccf152d5d23e59644bcdb8d580d41861992eb7e95d6a43c5e2be5b062356 loopback54473; resource.json/migrations.json/retained-databases.json.
- all-c3539f25-c412-49a5-820a-c96520c96ef8: exom-rest-t2d-700cb442-43f1-450b-a10d-e5b37c0f6c3c ID a0c19e28ece29194932f6bf8bda2bd9b8f59d543a2f71fe9913fb18f56091e06 loopback56932; resource.json/migrations.json/retained-databases.json.
Database/role exom_ci; PGDATA /var/lib/postgresql/exom-ci-data. ALL12 databases retained; all old/new logs/failures/clusters preserved, connection release only.
artifact-preservation.json inventories5893 existing T2D files; only README visible, generated output ignored. Source queries/projection remain visible; no deletion/movement/ignore edits. Recovery LOCAL ONLY, not archive delivery.

API feat/progreso-adherencia-p4/origin/feat/progreso-adherencia-p4 HEAD9161c48c000fd2c88f4bb26b1666136cd9bc521d. Status10:6 tracked changes and4 untracked (README/query/projection/unrelated preserved probe); no visible generated noise, staging unchanged. No deterministic defect or required-check failure found. Native/scoped closure and any next unit remain parent pending; no P6. Memory tools unavailable; safe evidence handoff retained.

## Final passive reconciliation — native approved, commit pending

The independent section above is preserved dated evidence from before the completed parent-observed ACK; its native-pending/NOT_RUN statements describe that verifier's actions, not the current disposition. Existing RED/FAIL chronology remains unchanged, including the honest 403-to-401 expectation correction for the existing inactive-staff guard contract. No functional or native lifecycle was rerun for this documentation update.

**Native parent-observed result:** lineage `review-853d15fa2b0d51d7`; target `sha256:cb5225fdd7d426c2fe0d2a7832ee08bf5c99f4f1b28dad323e61f808a6f59f31`; candidate tree `bcb02560770a6f66f67a06d30d0617629f5bbb2c`; consumed revision `sha256:02a0328c2a1c980dd276557011559904a35a8134bdd5dd7bc252a824e1f2d63f`. Exact ACK returned `status: closed`, `authority: burned`; review approved and **no advisories emitted**. This records supplied authority, not a writer review invocation. Local commit with a Spanish message remains parent-pending; no commit SHA or global P5 DONE is asserted.

### Bounded acceptance covered and limits retained

| Covered by existing independent evidence | Boundary / remaining acceptance |
| --- | --- |
| HTTP49, unit45, PG24, ALL108 suites/1289 tests, zero pending; lint/nondeleting build PASS | Exact commands/local traces are above; no new test/build execution. No Nest build, live Firebase, full bootstrap/schedulers/OpenAPI, frontend/mobile or deployment claim. |
| Canonical independent OPEN next-task/next-review selectors; due/priority/creation/id ordering, empty/closed/cross-owner and null/old assignees | Reusable staff source is ready; no list or Seguimiento/Dashboard consumer, and **no P5-04 equality claim** until separately scoped consumer integration/UI validation. |
| Frozen UTC boundary/offset clocks and past/today/future overdue behavior | No separately forced request waiting across UTC midnight. Keep this as a future integration acceptance limit, not proof of an existing defect. |
| One bounded parameterized SQL statement for coherent selectors; allowlisted fields and persisted authorization | No separately forced concurrent direct-task-writer snapshot test; LIMIT bounds returned rows, not scanned work. Raw helper is not an authorization entry point. |
| Forced persisted role/assignment revocation waits and denial; representative task/metric/user/assignment preservation | Not complete production/bulk writer transactions, universal deadlock freedom, comprehensive lock graphs or all plan/message/history fixtures. Existing T2B FU-01/02/03/05 and independently OPEN R3-snapshot-collision remain unchanged. |

Source/recovery identity: [final tested manifest](after-all-582a06d7-501c-4b53-9920-941c1468a940/manifest.json), [independent source/hash audit](checkpoint/independent/hash-audit.json), [independent artifact inventory](checkpoint/independent/artifact-preservation.json), [recovery instructions](checkpoint/RECOVERY.md) and preserved independent snapshots at `checkpoint/independent/snapshots/`. The independent audit records all 13 live source/config identities matching their writer copies plus coordination hashes; inventory records 5893 then-existing artifacts. Only this README is updated after those receipts—prior hashes/inventory are historical records, not rewritten to include this final text.

**LOCAL ONLY:** existing snapshot/log/checkpoint links remain valid in this retained checkout; a fresh clone does not deliver ignored recovery files. Separate archive/delivery remains required and unclaimed. Parent owns coordination/scoped closure, final checkpoint capture and any authorized local commit. No automatic next-unit authorization, Dashboard equality, whole-P5 closure or resource disposal is implied.
