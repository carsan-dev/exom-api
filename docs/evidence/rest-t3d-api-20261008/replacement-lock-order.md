# REST-T3D-API-01b — real replacement/archive deadlock fixed

> Copia saneada para entrega: ubicaciones normalizadas; resultados, fechas y hashes conservan su significado histórico y corresponden al snapshot privado original, no a esta copia. WORKSPACE_ROOT identifica la coordinación; SDK_ROOT el SDK instalado; RUNTIME_ROOT las herramientas locales; TEST_ARTIFACT_ROOT los recursos privados retenidos, no publicados.


2026-10-08, bounded implementation and focused verification only. Actual A→new-B assignment replacement reproduced PostgreSQL `40P01` against actual admin-A archive. New FK parent user locks now precede assignment DML in sorted order. No retries, timeout changes, business SQL stand-ins, migrations, or new modules.

## Boundary and source identity

- Checkout `${WORKSPACE_ROOT}/exom-api`, branch `feat/progreso-adherencia-p4`, upstream `origin/feat/progreso-adherencia-p4`, base `b75eade58a5053667785649776a61eae5104d231`. Initial status: only original untracked probe, never run or edited.
- Coordination `${WORKSPACE_ROOT}/`: CURRENT already declared **01b IN_PROGRESS** before source writes; no coordination writes. Task SHA256 `6e7645e0aebc27d491ffe58b60701e5236371866494005a9dd9f964e1798a6b8`; AGENTS `f21dc8259e9ff8b7a02122efd9b1651a4a22859081c6871722b099c8476a38db`; plan `9332524f9d699412a19a9154a7a1db426c7d2688770d4cb6b5978db9d9e18a8c`. Snapshot identities, not coordination commits.
- Final regression, identical in final RED/GREEN runs: `09f4462ede545c02881714916e71dbc0b504c684d5e818cadcf7de36497bc9d5`.
- Users service: baseline `94f360cc583391f55b10152f842b6c84cc4dd553e743a655d47aaafee5dde68b`; final `ae26e3bcdff41b5fa297271ee2a0dc3336977097fb8a0cf298fd2eff951dbea1`.
- Unchanged launcher `8ddb17cf9bb139beaf5ae7fbd3b7108641dc97897328d10f5f9e0be68a60c42a`; guard `a7665cbfd2181eefb6dabca14b495e2f8a3520384a260479bf34d3fe135098bd`; original probe `8b5ba61a1cf147c643727dbfb2f7139126e6f08647906bb7cf5ad9004ddc8ac4`.

## Causal experiment

Original delegate `updateMany` actually completes; its count and transaction-visible inactive A row are asserted before obtaining the writer backend PID. Original `createMany` is not invoked until release. The unchanged production callback and guards run; default interactive transaction timeout remains 5 seconds. ADMIN B is created in the owned fixture and its assignment count is zero beforehand. Only expected `queueTemplate` output uses a typed recording fake; all other external methods deny. No AppModule or lifecycle/cron.

Final RED used baseline production restored by removing only the eight new lines, with final test bytes. `node scripts/run-client-archive-pg.cjs`: **FAIL, 11 passed / 1 failed**, 2026-10-08T18:07Z. New case fails expecting domain `NotFoundException`, receiving Prisma `P2010`, underlying PostgreSQL `40P01 / deadlock detected`.

| Phase | Actual query/provenance | Observation |
| --- | --- | --- |
| Before release | Archive PID75: `SELECT id FROM admin_client_assignments WHERE admin_id=$1 AND client_id=$2 AND is_active=true FOR SHARE` | `pg_blocking_pids(75)=[74]`, Lock; writer74 already deactivated A |
| After release | Writer PID74: `INSERT INTO "public"."admin_client_assignments" (...) VALUES (...)` | `pg_blocking_pids(74)=[75]`, Lock; reverse edge observed before PG victim selection |
| Schema evidence | `prisma/migrations/20260321173456_init/migration.sql:408` | Actual `client_id → users.id` FK, CASCADE; archive holds users FOR UPDATE |
| Final GREEN | Archive PID75: `SELECT id FROM users WHERE id IN ($1,$2) ORDER BY id FOR UPDATE` | Blocks on writer74 before assignment access; no reverse wait; replacement succeeds, archive returns NotFound |

Read-only CodeGraph callers plus actual source show `syncClientAssignments` has one caller, `updateClientAssignments`; its callers are the PUT route and users unit suite. The fix locks client and new admin FK parents, sorted, only when an insert is required, before any deactivate/reactivate/create DML. Existing empty-list revocation and role-write cases retain their original behavior and assertions. Challenge sync receives the existing transaction; its separate top-level advisory-lock branch is not entered. This does not certify every unrelated writer or latest-role semantics.

## Focused results and retained artifacts

All artifact prefixes below are under `${RUNTIME_ROOT}/AppData/Local/Temp/`; artifacts are LOCAL_ONLY. Each launcher folder includes `manifest.json`, `9.log` (92 migrations), `10.log` (query/PID/error provenance), and `jest.json`. Every run created a fresh retained container `exom-<owner>` and volume `exom-<owner>-data`; none was reused or removed.

| Run folder | Owner | Loopback port | Result |
| --- | --- | --- | --- |
| `exom-archive-pg-ygZOF0` | `archive-1791482382386-1e609e1a01fe` | 60797 | First causal RED; 10 pass / 2 fail, second failure was owned fixture restoration after first failed assertion |
| `exom-archive-pg-lrjdN8` | `archive-1791482490149-0cd7f56e46a5` | See manifest | RED after unconditional owned-state restoration: 11 / 1 |
| `exom-archive-pg-lHt5pw` | `archive-1791482541188-c386c7530128` | See manifest | First GREEN: 12 / 0 |
| `exom-archive-pg-zujnlS` | `archive-1791482837287-daceea507591` | 53389 | Final-bytes RED: 11 / 1 |
| `exom-archive-pg-2gjTsi` | `archive-1791482885915-d54d3565811a` | 53422 | Final GREEN 18:08:24Z: 12 / 0, zero skipped/todo/open handles |

Every launcher verified labels/container/image/mount ownership, exclusive 127.0.0.1 binding (not55493), `exom_ci` database/user, Linux `/var/lib/postgresql/exom-ci-data`, empty public tables before migration, cached PG17 image `sha256:f4c66b820c6f974249089d3d16d86a3698eae11e8746eb6644b2271031e91232`. Sterile environment, empty dotenv, explicit datasource aliases, TCP restricted to owned PG; HTTP/TLS/fetch denied. No production environment read or fallback, no real provider effects. Cleanup is scoped to fixture IDs.

- `node ${RUNTIME_ROOT}/AppData/Local/Temp/exom-01b-units-1791482541188-c386c7530128.cjs`: PASS **23/23 users.service unit tests**, zero open handles. Artifacts `exom-01b-users-unit-2PJ70e`; runner rechecked ownership of first GREEN resource, privately retrieved only that disposable generated credential, used existing empty dotenv/network guard and guard SQL identity. Exact final product bytes; no unit mock/assertion changes needed.
- `node node_modules/eslint/bin/eslint.js src/modules/users/client-archive.concurrency.spec.ts src/modules/users/users.service.ts --no-fix`: final PASS, 0 diagnostics. Earlier 54 lint errors in new harness (formatting, unknown-return annotations, fake require-await) were fixed by scoped manual edits, not product RED.
- `node node_modules/typescript/bin/tsc --project tsconfig.build.json --noEmit --incremental false`: PASS, unchanged project flags, no tracked build metadata output.
- `node scripts/run-client-archive-pg.cjs --self-check`: PASS, seven bad reports and three unsafe URLs rejected.
- `git diff --check`: PASS. AST-backed source comparison: all seven original `it`/`it.each` statements, representing nine old cases plus two production-writer cases, remain byte-identical including assertions. New case verifies A inactive, new B active, entire client and all metric rows unchanged, exactly one expected notification recording.

## Remaining gates

Independent parent verification, whole API build/suite, native candidate review and terminal Git actions remain pending; no P5 DONE. Existing REST-T3D-API-TSC-LEGACY-01 stays OPEN, no waiver or repeat of 83 diagnostics. Two qualified historical R3 warnings stay informational for later RECONCILE; no consumed review reopened. Catalog bulk writers, deletion, HTTP integration and populated-history scenarios are separate units. No stage/commit/publish/remote action. Only test, eight-line product fix, and this receipt are maintained changes.

## Scheduler metadata isolation dependency — 2026-10-08T18:57Z

Bounded follow-up under existing 01b/full-P5; historical results above remain unchanged. CURRENT in coordination already records this dependency before edits (task snapshot SHA256 `dcaa6fc637228149182f78ff771c493af84fbaa3b6de5a40b13a5c3508649754`). Same API base/branch; no coordination or product-source writes.

- Cause: the fifth scheduler metadata case sets NODE_ENV=production and requires actual AppModule. Correct production ConfigModule.forRoot attempts repository dotenv IO; this spec is not a configuration-loading test. Prior full-suite exit1/71 PASS and14 FAIL suite lines were incomplete, not final totals or equivalent-baseline waivers.
- Fix: spec-only +16 lines; inside its existing isolation callback, retain actual config exports and stub only ConfigModule.forRoot with typed Promise<DynamicModule>. Restore spies and unregister the mock after each case. Actual AppModule and ScheduleModule execute; all five original environment cases and every scheduler assertion remain unchanged. No DI/lifecycle/provider startup or production configuration changes.
- Fresh TEMP directory verified absent before creation: `${RUNTIME_ROOT}/AppData/Local/Temp/exom-app-metadata-20261008-boundary01/`. Generated runner/guard/empty fixture/logs only, explicitly authorized; no DB, aliases, credentials or resource reuse. Sterile CI=false environment leaves unchanged setup-database.ts verification condition inactive legitimately, without bypassing SQL identity guard. Network denied; repository dotenv content reads blocked before IO.
- Guard derived from fail-closed principles of existing full policy SHA256 `57e8daacd2aa96e70e778949a5c4d76b98d02fdbcda10a2570f6d64946292eb7`, but grants no owned-PG or HTTP permissions. Original full policy, launcher, guard and probe untouched.

| Exact focused command | Observed result |
| --- | --- |
| `node ${RUNTIME_ROOT}/AppData/Local/Temp/exom-app-metadata-20261008-boundary01/runner.cjs red` | Genuine unchanged-spec RED exit1: async fatal repository-dotenv denial at ConfigModule.forRoot → actual AppModule → spec production case. No final Jest counts/JSON produced; no content read, no network events. |
| `node ${RUNTIME_ROOT}/AppData/Local/Temp/exom-app-metadata-20261008-boundary01/runner.cjs green` | PASS exit0, 1 suite/5 cases, zero failures/skips/todo; repository dotenv attempts0/content reads0/network events0. Same runner/config/guard; ts-jest reports no affected-test TypeScript diagnostics. |
| `node ${RUNTIME_ROOT}/AppData/Local/Temp/exom-app-metadata-20261008-boundary01/runner.cjs lint` | PASS exit0; invokes installed ESLint for src/app.module.spec.ts only, --no-fix, no diagnostics. |

Spec final SHA256 `20ce7dc87cef863f713e7b346ad12d0d0c88f06517bd644c89e20ba7cb8a1e49`; runner `51e7ba2a58ee9e5cc4dcec7a32fc6df85e46b8e27a66424a78e3303129d519c6`; generated guard `894a65a23950054407073fef4a27ca2932162a4e200a121ebb8218b6c259c658`. LOCAL_ONLY red.log/green.log/green.json/guard-events.json/lint.log/manifest.json retain evidence; missing red.json is the observed fatal-abort consequence, not a completed test report.

Final Git whitespace/receipt EOF and aggregate candidate-size checks reported separately in handoff. Users/test/launcher/probe hashes stay identical to preceding receipt; no DB/container/server created. Full-suite gate remains FAIL/incomplete pending corrected parent HTTP/history/tracking harness; full lint/schema/build evidence belongs to parent CURRENT, not new runs here. No broad suite/build/compiler repeat, legacy83 waiver, native action, stage/commit or P5 DONE.

## Bounded TEMP transport preparation — 2026-10-08

- Fresh authorized `${RUNTIME_ROOT}/AppData/Local/Temp/exom-api-full-20261008-boundary02/` only; partial transport plus fixture recipe, **full NOT_READY**. Source pins in recipe; no product/test/guard/launcher/probe changes.
- Strict TDD runner `node ${RUNTIME_ROOT}/AppData/Local/Temp/exom-api-full-20261008-boundary02/launch.cjs self-check`: actual Supertest RED four failures (`address()` null/port), own fetch/TLS/nine negatives PASS; same four expectations GREEN after public prebind/deferred adapter.
- Final self-check PASS nine groups: GET/query/header/body/status/then/end/agent cookies/defaults, assertion rejection, expect callback/error, concurrent requests, auto-close and caller-owned prebound lifecycle; own fetch/TLS and nine destination/identity negatives; zero live permits after normal server close. No external connections or DB created.
- `node --check` each of launch.cjs, transport.cjs, supertest-ready.cjs, self-check.cjs PASS; exact commands in syntax.log. LOCAL_ONLY self-check.json preserves RED then GREEN observations, guard-events.json and self-check.log retain synthetic evidence.
- Source-confirmed future recipe: normal fresh cluster ON/main92; separate fresh history cluster OFF/main92/legacy84 only; baseline test itself applies migration85. Parent operational matrix supersedes earlier same-cluster requirement, not assertions.
- Provision, actual Jest VM route/env isolation proof, PG grants/original SQL guard integration, config-input equivalence and full/source-check commands remain unimplemented/NOT_RUN; complete preparation forecast exceeds450 generated code lines. No full-suite/build/native/commit/P5 completion claim.

## PREPUNIT02 partial VM/config preparation — 2026-10-08T19:56Z

- Fresh TEMP boundary03, 216 CJS LOC; `node ${RUNTIME_ROOT}/AppData/Local/Temp/exom-api-full-20261008-boundary03/launch.cjs self-vm`: real Jest RED3pass/1fail each order (history OFF received ON) → same assertions GREEN4/4 each order, 0pending/network; host unchanged and cached process/node:process VM imports isolated. SQL guard not executed; hook snapshot models ordering only.
- Static build-config equivalence PASS5959 identical inputs SHA7927e519da27689c2a3c111b60ae3c229907d10dbfe1186dbde0ae919e7672c9; options differ only TEMP output/buildInfo/config location. Original Jest selection/root/setup retained; 15 actual Supertest consumer specs audited, no direct Test props/HTTP2 found. Five Node syntax checks PASS; no build/full suite executed.
- Pins: launch69d289b570527300bb39181b10e36c177b485f3af2ea8909d6d0a3759acbc278; setup83f85441147e4a0f9731d58652d6a40304a5547222b468a86db61318b2cec574; selfVM0db4b4b38ddb2b0c9cdd0e7eba97a9ea3e4ac22ccf2ac46e58db94a231a8f64d. LOCAL_ONLY recipe records harness JEST_WORKER_ID/AST-audit failures, fixed without hiding host mutation or weakening assertions; self-vm.json/log retain RED/GREEN.
- fullReady=false; provision/PG guard grants/transport integration/actual npm orchestration NOT_IMPLEMENTED/NOT_RUN. Complete forecast >450 LOC: next bounded provision part then CLI integration, no fake ready launcher. Boundary02 artifacts read-only/unrun; no Docker/migration/resource/secret/source/native/Git changes or P5 closure. Final manifest pins this receipt after append, outside hash cycle.

## PREPUNIT03 provision04 preparation — 2026-10-08

- Fresh boundary04 only: direct `node <boundary04>/self-check.cjs` observed pure-validator RED5/24 then GREEN25/25, all network denied; synthetic ownership/URL/context/SQL-identity/prefix-byte/redaction cases are not physical SQL proof.
- `node --check <boundary04>/{provision,launch,self-check}.cjs` individually PASS. Source/prior pins and actual92/prefix84/baseline85 checked; recipe-generation path typo failed before writes then corrected, no hidden execution failure.
- Future exact `node ${RUNTIME_ROOT}/AppData/Local/Temp/exom-api-full-20261008-boundary04/launch.cjs provision` prepared, NOT_RUN; Docker/SQL/Prisma/ACL/full checks NOT_RUN, readyGroup=false/fullReady=false. Boundary02/03 unchanged/unrun; orchestration05 remains separate, no source/config/test/guard/native/Git mutation or P5 completion.

## Verified final-source checks — 2026-10-09

This supersedes the pending full/independent checks above, not their historical outcomes. The three maintained source hashes remain unchanged; this appendix is documentation only. Native review and exact-tree commit remain pending.

- Independent full command, once: `node ${RUNTIME_ROOT}/AppData/Local/Temp/exom-api-full-20261008-boundary11/launch.cjs full`, PASS; observed outer UTC00:03:33.198–00:13:59.468, including preflight. Actual original npm test command/config: **110/110 suites, 1377/1377 cases**, zero failures/pending/todo/runtime errors. Archive12, scheduler5, history baseline9, commit metadata7, TLS4, data-access45 and all HTTP contracts passed.
- Original full lint `npm run lint -- --no-fix`, Prisma `npm exec -- prisma validate`, and actual Nest `npm run build -- --path <OWN-run>/tsconfig.equivalent.json` PASS. Lint retains two warnings at progress.concurrency.spec.ts474/482; no waiver. Build preserves5959 inputs; emitted users.service.js41589 bytes, SHA256 `be2047af2bfd8cb896dabd504fecb1c750acb54ab85d5996772189d106d24218`.
- Final evidence: `${RUNTIME_ROOT}/AppData/Local/Temp/exom-api-full-20261008-boundary11/runs/85f5341b-0aeb-4bbd-85b4-d3b02c844369/final.json`, SHA256 `519f79d802d66f56d9c7cf6d6eb54c56a6917a7b9318752617c3a1d018932e47`; adjacent Jest/log/config/registry evidence is LOCAL_ONLY. New owned PG17 group `d9b5cf21-dc51-43bd-9764-3a788b1876d7`, loopback61754 ON92 /61758 OFF92, legacy template84. Container/image/volume ownership, SQL exom_ci identity/Linux data directory, initially empty public schema, tracking modes and ACLs verified before DDL. All resources retained.
- Real before/after SQL guards for each of110 suites cover both modes; host PID/nonce-bound endpoint grants, one installation/exit-writer,13 final registries/live0, all13 recorded processes subsequently absent. The Node policy is not a universal native sandbox. No real repository dotenv/provider credentials, external delivery, old-resource reuse or cleanup.
- Failed setup/full attempts retained in parent CURRENT and their immutable TEMP directories: unsupported Jest extension, TEMP module resolution, cache denial, virtualized Jest createRequire, literal-loopback DNS and owned-socket TLS rejection. Full08 interrupted after47min; full10 completed109/110 suites and1376/1377 cases, failing an original100ms pool acquisition before assertions. No intermediate PASS substituted for full evidence.
- Causal runtime repair: original pg-pool timer starts before connect; synchronous Docker inspection added~258ms inside the100ms deadline. Physical and unchanged SQL guards moved to suite boundaries, with exact-owner/PID/nonce/port revocable grants on connect; no source timeout/assertion changes. Actual smoke77/77 then full1377/1377 passed the original100ms/max2/idle50ms contract. Native certificate verification and all original assertions remain intact.
- Original typecheck `node node_modules/typescript/bin/tsc --project tsconfig.json --noEmit --incremental false --pretty false`: **FAIL exit2**,83 diagnostics identical by code/path/line/column/full message to equivalent base; added0/removed0. Actual22 diagnostic-bearing spec files have base c080319 byte-identical hashes; earlier23-file summary is corrected, not waived. The three modified source files have zero diagnostics. Evidence TEMP `exom-api-01b-final-tsc-20261009.json` SHA256 `860c2cd591edeeb4517904b05a4b6cd5dc314131f30c27f6f940b2c34ebbedd8`, log SHA256 `340104ebf741d06c5904e371227ac96a3d4053adfac5dae76b108b623b82006e`. REST-T3D-API-TSC-LEGACY-01 and P5 remain OPEN.
- Original probe unrun; prisma generate NOT_RUN because no schema/generated-client drift. Git status/diff-check/source504 hashes unchanged during full verification. Catalog bulk/request/history and remaining P5 acceptance stay separate; this is narrow replacement/archive closure evidence, not deployment or P5 DONE. App/Admin commits and consumed reviews remain untouched.
- Appending this receipt changes its frozen918960 hash: old TEMP provision recipes are historical and must not be replayed against the new candidate. No functional source changed after the passing checks.
