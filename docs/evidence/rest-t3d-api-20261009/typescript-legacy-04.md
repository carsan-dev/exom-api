# TSC-LEGACY-04 — stage 1 typing receipt

> Copia saneada para entrega: ubicaciones normalizadas; resultados, fechas y hashes conservan su significado histórico y corresponden al snapshot privado original, no a esta copia. WORKSPACE_ROOT identifica la coordinación; SDK_ROOT el SDK instalado; RUNTIME_ROOT las herramientas locales; TEST_ARTIFACT_ROOT los recursos privados retenidos, no publicados.


Dependency reference (2026-10-09): [canonical catalog restoration](contract-catalog-restoration.md) records generated-contract repair, the historical OpenAPI export blocker and its authorized metadata-only resolution. The point-in-time results below remain unchanged; this reference claims no functional GREEN or closure.

## Candidate and boundary

- Stage 1 complete; functional acceptance **NOT_DONE / NOT_RUN**. Independent verification, native review and commit remain pending. P5 remains OPEN.
- API root: `${WORKSPACE_ROOT}/exom-api`; coordination root: parent `EXOM`, not Git. Coordination AGENTS/task snapshot hashes are in the manifest; coordination documents were not edited.
- Base `a4a97d8dfc005a9b8d69e4cafac24e8e3163440a`; branch `feat/progreso-adherencia-p4`; upstream `origin/feat/progreso-adherencia-p4`.
- Exactly the 13 authorized diagnostic-bearing specs changed: source diff +71/−32 (103 lines). No production, configuration, dependency, runner or resource changes. This receipt is the only additional repository file.
- Original untracked probe and four foreign cache files preserved byte-for-byte, unrun. Repository DB setup/authentication/roles guards unchanged; no environment files, credentials or private connections read.
- Artifacts: `${RUNTIME_ROOT}/AppData/Local/Temp/exom-api-tsc-legacy-20261009-04/manifest.json`, SHA256 `8f5fb629588190cfa2e25dd62b28f28f26cecd81412bd4165c1a1479739b55ae`. All 13 full source paths have before/after SHA256, expanded case count and emitted-JS comparison. Baselines and proof outputs are beside the manifest.

## Confirmed causes and fixes

- Request.user (4): local Express Request intersections with actual AuthenticatedUser; real role checks and middleware bodies untouched.
- Ledger (1): installed Jest MockedFunction of the generated generic queryRaw signature, configured with mockResolvedValue. No arbitrary-T implementation, cast or PrismaPromise branding fabrication. This is a Jest mock, not a real Prisma executor; same stored rows and promise resolution behavior.
- Deletion counts (2): concrete generated delegates called through client-id callbacks in original model order; both original count expectations retained logically, with two explicitly changed assertion call sites.
- Exercises/data-access constructors (2): actual required UploadsService supplied using a test ConfigService and the same DB object. No constructor contract changes, undefined dependency or new unsafe cast. Upload methods remain unused in these reader cases; S3 client construction is new fixture runtime activity, not storage/network validation.
- Metrics/app HTTP server (2): use NestExpressApplication's actual nongeneric server contract.
- Photos (2): infer fulfilled-result narrowing instead of a predicate claiming incomplete result fields.
- Aggregate (1): full generated DurableWork fixture with original owner/payload; no partial-object cast. Added scheduling/status fields are fixture data, not new persisted writes.
- Training detail (6): fail-fast page/tail guards, no optional bypass or assertion removal. Existing cursor assertion retained.
- Overview (9): typed Nest get establishes initialized Prisma; page test fails fast if missing; cleanup IDs typed as legitimate strings, retaining exact UUID values and ownership checks.
- App query rejection (1), corrected under parent authorization: callback-last pg overload makes mockRejectedValueOnce's parameter never. A structurally checked local view of the same pool selects its real QueryConfig → Promise overload; spyOn still replaces/restores the actual pool method. mockImplementationOnce returns Promise.reject, preserving original asynchronous failure, exact catch/503/redaction/recovery assertions. No cast, suppression, production API change or synchronous-throw substitution.

## Observed stage 1 verification

- RED: authenticated original `...-03/independent-tsc.log`, SHA256 `dbe07bacdb40d851a682298694aa8a4820402418eadc1a19b6c2c8fd2a1af42e`; 30 diagnostic entries. Typing regression only; no artificial business RED.
- `node node_modules/typescript/bin/tsc --project tsconfig.json --noEmit --incremental false --pretty false`: rounds 1 and 2 **PASS exit 0**, empty full logs. Full semantic delta: 30 removed, 0 added, 0 remaining. Installed TypeScript performs the original project check; no flags/config weakened.
- `node node_modules/eslint/bin/eslint.js` with all 13 manifest source paths in listed order and `--no-fix`: round 1 **FAIL exit 1**, 40 formatting errors; round 2 **PASS exit 0**, 0 diagnostics. First failure preserved; only local alias/layout repair, no lint disabling or auto-fix.
- `git diff --check`: **PASS** before receipt and final handoff. Original compiler/lint outputs remain separate fresh round files.
- AST comparison **PASS**: all 605 assertion AST calls, case names, each parameter tables and enclosing registration-loop headers preserved, except the two documented equivalent deletion-count substitutions. No assertion deleted. Original fixture UUIDs and training shape parameter data unchanged.
- Static expanded cases: achievements6, ledger19, deletion26, exercises7, metrics7, photos3, aggregates12, training-read44, publication37, recaps13 (8 PG + 5 mock HTTP), data-access45, app10, overview6 = **235**. Data-access expansion is 15+11+3+7+9; app7+3; overview2+4. These are source counts, not executed results.
- Five specs emit identical JS: achievements, metrics, photos, publication, recaps controller. Other eight change fixture runtime as described above; no production JS change claimed from fixture identity.
- Initial AST proof syntax failure retained in `compare.cjs`; corrected `compare-round2.cjs` passes. A static-count probe failed on as-const/spread syntax; source expansion was inspected directly, not replaced with declaration counts. Failure summaries remain in the manifest; no functional test runner was created/executed.

## Targeted correction — fresh round 3

- The prior synchronous throw was rejected by parent review because it weakened asynchronous-failure coverage; this correction supersedes that fixture decision. Old manifests, seals and logs are immutable historical artifacts, not final candidate bindings.
- Initial direct Promise-returning mock: original TSC **PASS0**, focused lint **FAIL1** no-misused-promises because Jest selected pg's final void callback overload. Preserved in tsc-round3.log/lint-round3.log. The checked promise-overload view resolves this without disabling lint or changing rejection behavior.
- `node node_modules/typescript/bin/tsc --project tsconfig.json --noEmit --incremental false --pretty false`: **PASS exit0 / 0 diagnostics**, tsc-round3b.log.
- `node node_modules/eslint/bin/eslint.js test/app.e2e-spec.ts --no-fix`: **PASS exit0 / 0 diagnostics**, lint-round3b.log. Other twelve sources retain prior passing pins.
- `node ${RUNTIME_ROOT}/AppData/Local/Temp/exom-api-tsc-legacy-20261009-04/async-query-round3.cjs`: **PASS**. Extracted source callback returns a rejected Promise without immediate throw; rejection observed/handled. Installed jest-mock and actual transpiled HealthService prove awaited rejection redaction and recovery in a read-only VM with a synthetic pool; **not** real HTTP/PG acceptance.
- All original app assertion/case/parameter AST preserved; other twelve source hashes unchanged. Total remains **235 cases**, functional tests **NOT_RUN**. Final diff-check PASS. No resource, production, native review or Git mutation.
- Fresh candidate binding: `${RUNTIME_ROOT}/AppData/Local/Temp/exom-api-tsc-legacy-20261009-04/manifest-round3.json`; includes original/current source hashes, prior document hash, final document hash and fresh log/proof pins. Never use the historical first manifest as the corrected source binding.

## Stage 2 — candidate-bound runtime PREPARED, functional NOT_RUN

- Selected smallest reusable route: bounded copy of proven boundary11 HTTP/SQL orchestration plus its original 02 transport, 03 selector/config equivalence, 04 provisioner and 05 configuration utilities. OWN03's identity launcher denies HTTP/TLS, so cannot serve these e2e. No new guard architecture or source changes.
- Preparation root: `${RUNTIME_ROOT}/AppData/Local/Temp/exom-api-tsc-legacy-20261009-04/runtime/`. Copies and origins recorded in origins.json; executable bindings in prepare-manifest.json. Historical directories, original manifest-round3.json (SHA 6a47211772d9bd0522301ed3461f5942ec4c4904e32d801d63183555c679944c), logs and proofs remain immutable. Source13 pins retained.
- Exactly three selections: unit3 suites/32 cases; PG+HTTP8 suites/187 cases; e2e2 suites/16 cases, total235. Original package and test/jest-e2e.json transforms/selectors preserved. The latter uses its original test root plus the existing owned environment/SQL setup. No full1377 or historical runner execution is claimed or scheduled.
- Future invocation creates a fresh nonce/group/output each time: copied04 unchanged PG17 image pin and --pull=never, owner-labelled volumes, prestart mounts/data directory, exclusive ephemeral loopback excluding55493, ON/OFF SQL identity and empty public schema before DDL, deploy92/92 plus original84 legacy template, protected private/output ACL. No reuse or cleanup. Provisioner source is byte-identical to historical04.
- Native host PID/nonce bridge, virtualized createRequire repair, actual Supertest prebinding, native TLS socket handling and literal127 DNS policy copied unchanged except import locations and the necessary exact selected src/test suite-path allowlist. Physical/SQL checks stay at bootstrap/beforeSuite/afterSuite, not per-connect; original100ms acquisition deadline unchanged.
- Child environment is sterile OS-only plus owned DB aliases and known-fake R2 values from the existing uploads.service.spec.ts fixture. No real Firebase keys or credential files: overview retains its original auth-guard test double; anonymous app checks retain original rejection. No provider network grants. Scheduler opt-in is the existing explicit test/127/smoke flag; e2e enables the existing page-plan diagnostic branch. Repository dotenv reads remain denied; only fresh empty dotenv paths are permitted.
- Preparation validation: all14 copied/preparation CJS files pass node --check; self-check.cjs passes unchanged compiler input5959/config selections and27 inherited pure negative checks. Copied runtime adaptation conservatively counts62 added lines including its27-line static self-check, excluding one-off copy preparation and JSON bindings. Provisioner/transport/selector/owned Jest setup/Supertest adapter retain original bytes; network differs only in import relocation and the exact selected suite-path gate.
- Static configuration and pure negative checks are preparation evidence only, **not PASS of PG/HTTP/Jest**. Actual VM/transport replay, ownership, migrations, ACL and all235 functional cases remain NOT_RUN until the parent delegates execution.
- Immutable future commands (run in foreground; host timeout10800 seconds each; child unit300000ms, PG/e2e7200000ms, original test deadlines untouched):
  `node ${RUNTIME_ROOT}/AppData/Local/Temp/exom-api-tsc-legacy-20261009-04/runtime/11/launch.cjs unit`
  `node ${RUNTIME_ROOT}/AppData/Local/Temp/exom-api-tsc-legacy-20261009-04/runtime/11/launch.cjs pg`
  `node ${RUNTIME_ROOT}/AppData/Local/Temp/exom-api-tsc-legacy-20261009-04/runtime/11/launch.cjs e2e`
- Outputs stay beneath runtime/04/runs/<freshUUID> and runtime/11/runs/<freshUUID>; redacted final reports require exact paths/per-suite cases, no failed/pending/TODO/runtime errors/reported open handles, real SQL receipts and zero-live PID-bound transports. Missing evidence fails closed. This preparation authorizes no execution itself.

## Minimal next functional authorization (proposals only)

All commands below are **NOT_RUN** and require new candidate-bound isolated resources/runtime authorization. Never execute historical frozen boundary11 against this candidate. No new framework is needed: bind a bounded new copy only if the parent authorizes it. Preserve all original default timeouts/interleavings and verify actual counts/no unintended pending cases.

- Unit/mocked HTTP, 32 cases:
  `node node_modules/jest/bin/jest.js --runInBand --detectOpenHandles --no-cache --runTestsByPath src/modules/achievements/achievements.controller.spec.ts src/modules/adherence/adherence-commit-ledger.spec.ts src/modules/exercises/exercises.service.spec.ts`
- PostgreSQL and real HTTP/PG, 187 cases (includes recaps' five mock HTTP cases):
  `node node_modules/jest/bin/jest.js --runInBand --detectOpenHandles --no-cache --runTestsByPath src/modules/client-deletion/client-deletion.concurrency.spec.ts src/modules/metrics/metrics-overview.concurrency.spec.ts src/modules/progress-photos/progress-photos.concurrency.spec.ts src/modules/progress/aggregates.concurrency.spec.ts src/modules/progress/training-progress-read.concurrency.spec.ts src/modules/recaps/recap-review-publication.spec.ts src/modules/recaps/recaps.controller.spec.ts src/prisma/data-access.concurrency.spec.ts`
  Required: fresh attested TEST_DATABASE_URL; databaseUrl/SQL guards; matching DATABASE_URL/PRISMA_DATABASE_URL where used, DATABASE_SSL_MODE=disable, NODE_ENV=test, FOLLOWUP_HTTP_PG=1. Synthetic provider configuration only; no production fallback. Real native HTTP boundary, not fake Supertest results.
- Separate e2e configuration, 16 cases:
  `node node_modules/jest/bin/jest.js --config test/jest-e2e.json --runInBand --detectOpenHandles --no-cache --runTestsByPath test/app.e2e-spec.ts test/p3-t6-b-training-overview.e2e-spec.ts`
  Required: fresh attested isolated DB, NODE_ENV=test, HOST=127.0.0.1, EXOM_SMOKE_DISABLE_SCHEDULERS=1, DATABASE_URL=TEST_DATABASE_URL, synthetic provider settings. Preserve overview diagnostic branches; authorize EXOM_P3_PAGE_EXPLAIN=1 for the changed optional page-plan path when functional validation is scheduled.
- Existing package Jest rootDir=src excludes both affected e2e files. A full `npm test -- --runInBand` does **not** cover them; test/jest-e2e.json is required separately. Integration wrapper minima are broad-suite gates, not a substitute for this candidate's exact focused case accounting.

## Final actual verification — 2026-10-09, before parent freeze

- This passive append supersedes prior PREPARED/NOT_RUN statements only for the checks now evidenced; all historical PASS/FAIL and proposals above remain point-in-time. No functionality change or new execution occurred during normalization. Base remains parent-reported `a4a97d8`; candidate uncommitted.
- Independent original project TSC **PASS exit0 / zero diagnostics**: all 30 TSC-LEGACY-04 entries resolved, **83/83 total** legacy diagnostics resolved across the completed typing work. The 13 typed fixture source pins remain unchanged from their last compiler-verified revision.
- Original command `node node_modules/typescript/bin/tsc --project tsconfig.json --noEmit --incremental false --pretty false` and no-fix lint of all 13 fixtures **PASS**; independent DTO registry diagnostic count **0**. Empty logs: `${RUNTIME_ROOT}/AppData/Local/Temp/exom-api-tsc-legacy-20261009-04/independent-tsc.log`, `independent-lint.log`; catalog final and acceptance logs are linked in the companion receipt.
- Actual functional GREEN: **265 UNIQUE cases = 32 unit + 187 PG + 46 e2e**, not 269. Unit/PG selections and their source pins are unchanged; fresh e2e is app10 + overview6 + contracts30. Repeated app/overview executions and the historical contracts28 run are not additive coverage.
- Actual foreground commands: `node ${RUNTIME_ROOT}/AppData/Local/Temp/exom-api-contracts-20261009-01/runtime-final/11/launch.cjs unit` and the same launcher with `pg`: **PASS32 / PASS187**. Exact child Jest commands, suite/case names and logs are in their final reports.
- Unit report: `${RUNTIME_ROOT}/AppData/Local/Temp/exom-api-contracts-20261009-01/runtime-final/11/runs/8dacee96-01b3-4e8b-aa86-62d00ffa9d29/final.json`, SHA256 `f2b79ac13bea7fbe9b13e7c78db672e28aa4cb0f6f23e7cf01d83bcfb9fed376`.
- PG report: `${RUNTIME_ROOT}/AppData/Local/Temp/exom-api-contracts-20261009-01/runtime-final/11/runs/e79369b0-a08c-4730-9f86-729bd30369c3/final.json`, SHA256 `4d2535f1bf7599b56a8b59f4284f7bcff110490cdae5d726aa9b4b2900c3a92c`.
- [Catalog restoration final actual verification](contract-catalog-restoration.md#final-actual-verification--2026-10-09-before-parent-freeze) binds fresh46, HTTP/Ajv/privacy/DTO negatives, metadata/export and ownership evidence. All selected groups have zero failed/pending/TODO/runtime-error cases; registry transports finish live0. MaxListeners/pg deprecation warnings are non-failing observations.
- Preservation limit: runtime source/post-pins, original probe and foreign caches **PASS**. Independent full-history comparison stopped at the old typing receipt hash, a legitimate prior revision documented by `manifest-final2.json`; the remaining historical-artifact audit **NOT_COMPLETED**. This is not an assertion that every historical artifact was independently preserved.
- TDD remains ENABLED (ODD/AGENTS): passive evidence append has no meaningful new RED; historical startup/export RED → actual functional GREEN retained. Full1377 **NOT_RUN**; no deployment/production/remote action or cleanup. Resources retained. Parent native review and local commit remain pending; other P5 acceptance remains **OPEN, not DONE**.
