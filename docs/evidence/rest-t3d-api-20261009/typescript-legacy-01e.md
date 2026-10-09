# TSC01E — bounded legacy spec typing (2026-10-09)

> Copia saneada para entrega: ubicaciones normalizadas; resultados, fechas y hashes conservan su significado histórico y corresponden al snapshot privado original, no a esta copia. WORKSPACE_ROOT identifica la coordinación; SDK_ROOT el SDK instalado; RUNTIME_ROOT las herramientas locales; TEST_ARTIFACT_ROOT los recursos privados retenidos, no publicados.


Status: PARTIAL; focused lint fails. Independent parent/native review pending.
Root: `${WORKSPACE_ROOT}/exom-api`.
Base: `7e16227db1f52d9972e5f907f4de8371fdbef9b0`, branch `feat/progreso-adherencia-p4`, upstream `origin/feat/progreso-adherencia-p4`.
Initial tracked tree clean; `%SystemDrive%/` and `scripts/probe-client-deletion-lock-order.cjs` untracked and preserved.
Parent coordination CURRENT/539 supplied before writes; not modified by this worker.

## Changes and semantic proof
- Trainings: removed only the explicit `@jest/globals` expect import; kept the original two-argument matcher and every assertion, fixture and case.
- DTO: annotated `recapDto` return as `CreateRecapDto`; preserves nullable contract and all values/validation cases.
- Owned Jest setup proves imported/global expect strict reference equality inside the installed runtime. Same matcher state, helpers, results and errors; no production assertion patch.
- Exact source replacement checks pass. DTO transpiled JS is byte-identical; training JS differs only by removal of the import and substitution of its expect binding (verified after normalization).

## Evidence and commands
Owned root `T = ${RUNTIME_ROOT}/AppData/Local/Temp/exom-api-tsc-legacy-20261009-01e`.
`node T/launch.cjs before writer`, `seal writer`, `snapshot writer`: PASS; BEFORE.json, FINAL.json, manifest.json contain pins, source snapshots and actual commands.
Strict diagnostic RED: prior `01d/verify1/tsc.log`, SHA256 `c4d6490ae582125ce2f30435c9b3e8e842629c50aac60663e8bf9e7f6a076524`, verified before edits; 58 diagnostics including the selected TS2554 and TS2322.
`node T/launch.cjs jest writer`: PASS, 2 whole suites, 34 training + 8 DTO cases, 42 passed, zero skips; writer/jest.log, jest.json, expect-identity.json.
`node T/launch.cjs tsc writer` runs `node node_modules/typescript/bin/tsc --project tsconfig.json --noEmit --incremental false --pretty false`: global FAIL, exit 2, 56 remaining diagnostics.
`node T/compare.cjs compare writer`: PASS, exactly 2 removed, zero added, all remaining full messages/path/code/positions identical; writer/comparison.json.
`node T/launch.cjs lint writer` runs `node node_modules/eslint/bin/eslint.js src/modules/trainings/trainings.service.spec.ts src/modules/recaps/dto/create-recap.dto.spec.ts --no-fix`: FAIL, seven training unsafe-assignment errors at lines 124, 193, 243, 529, 878, 879, 1151; DTO clean.
`node T/lint-launch.cjs lint lintproof`: FAIL. Original-source lintText returned zero messages, final returned seven; equivalence assertion correctly failed. These errors are NOT waived as pre-existing; see lintproof/lint.log.
First `node T/launch.cjs compare writer` timed out after 60s due repeated whole-pin hashing; writer/compare-attempt1.log retained. Optimized compare.cjs hashes once; no criterion weakened.
`git diff --check`: PASS; both edited specs retain final newline.

## Isolation and limits
Sterile allowlisted environment, NODE_ENV=test, CI=false, owned empty.env; no inherited credentials, network/listeners or outside writes. Writer guard logs have zero denied events.
Installed original Jest config, ts-jest and database setup retained, with an additional owned identity-proof setup. Original SQL setup is legitimately inactive: NONDB mock suites, NOT PostgreSQL evidence.
No source providers changed; existing Prisma/materializer mocks retained. No build, full suite, schema, generation, dependency, production/config/Git/native writes or prior runtime mutations.
Strict GREEN applies only to the two resolved diagnostics and complete runtime suites, not global compilation/lint. Runtime-preserving typing changes do not manufacture business-behavior RED.
Fresh independent verification: `node T/launch.cjs snapshot verify1`, then `jest verify1`, `tsc verify1`, `node T/compare.cjs compare verify1`, `node T/launch.cjs lint verify1` (one foreground command at a time).
Snapshot pins selected FINAL targets and strictly unchanged other tracked non-sensitive files plus original probe and installed Jest declarations. Sensitive filenames excluded without reading; original untracked cache untouched.

## Final source SHA256
- `src/modules/trainings/trainings.service.spec.ts`: `3bbe73a2e1e14c7379604a5c9da90972d4dd8899d9bb2c1a7ba3779df45545ee`
- `src/modules/recaps/dto/create-recap.dto.spec.ts`: `c6ca943fd17b7a41dc0ad5179ec6cb256ec680b9392ec3e1366b3358908fd481`

Next permitted action: parent disposition of surfaced lint errors and independent verification; no further expansion performed.

## Causal correction — final bounded repair (2026-10-09)
This section supersedes the initial diagnosis, edit description, pins and proposed verification above; historical failures remain preserved.
Parent coordination CURRENT/979 supplied; verified HEAD/base/upstream unchanged before writes. Existing dirty/untracked files preserved.
Parent's original-source Compiler API evidence places TS2554 at 601:76 on `toHaveBeenCalledWith(expect.any(Function), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead })`, NOT `toHaveProperty`.
Installed Jest `expect/build/index.d.ts:276` uses `MockParameters<T>`; the fixture's one-element `$transaction` mock tuple rejected the second argument.
Restored byte-exact original `@jest/globals` import. Both mock tuples now use `[unknown, TransactionOptions?]`, where `TransactionOptions = Parameters<PrismaService['$transaction']>[1]`.
Generated Prisma interactive overload at `.prisma/client/index.d.ts:771` supplies optional maxWait/timeout/isolationLevel; no new any, casts or unrelated mock-field changes.
Alias replaces an existing blank line, preserving all downstream positions. DTO's existing return annotation remains byte-identical to the initial edit.
Fresh pins: `T/repaired-final/FINAL.json`; separate run manifest: `T/verify2-final/manifest.json`. Old writer/FINAL.json is historical, NOT final authority.
`node T/launch.cjs seal repaired-final`, then `snapshot verify2-final`: PASS, timestamped fresh source/dependency/guard pins; unrelated tracked files/probe unchanged.
`node T/launch.cjs jest verify2-final`: PASS, 34 training + 8 DTO = 42 cases, 2 whole suites, zero skips.
`node T/launch.cjs tsc verify2-final`: global FAIL (exit 2), exactly 56 remaining diagnostics; selected TS2554/TS2322 absent.
`node T/compare.cjs compare verify2-final`: PASS, 58 -> 56, exactly 2 removed/0 added; remaining full messages/paths/codes/positions identical.
Comparison now proves BOTH original-base versus final emitted JS byte-identical, without import/binding normalization; exact source edits preserve assertions/data/cases.
`node T/launch.cjs lint verify2-final`: PASS, exit 0, no errors or warnings, both files, no fix.
`node T/final-proof.cjs`: PASS, emitted assertions/cases/data AST identity, 42-case counts, EOF, current source hashes and three guards with zero denied events; `verify2-final/final-proof.json` hashes fresh reports.
Intermediate `verify2/lint.log` retains two formatting failures; shortened typed alias resolved them before all final checks were repeated. First AST proof erroneously compared enclosing source text containing erased annotations; corrected to emitted AST identity, with compact hash assertions.
Initial writer/lint FAIL 7, lintproof FAIL 7 and compare-attempt1 timeout remain untouched. Parent-reported oversized Compiler API output preserved as pi-bash3cd log; no source cause/private exposure known, not read. This worker's oversized initial AST assertion output is preserved at `${RUNTIME_ROOT}/AppData/Local/Temp/pi-bash-a5f15a59cdfd432a.log`; source-only assertion-tool failure, not product failure.
Training SHA256: `b920ccc206bf67a80c9bb0d97b81caa185edb0d8e6a6e29031b7bfdc822dea0f`.
DTO SHA256: `c6ca943fd17b7a41dc0ad5179ec6cb256ec680b9392ec3e1366b3358908fd481` (unchanged).
Sterile NONDB/CI=false, owned empty dotenv/cache, unchanged net/write-deny guard; original SQL setup legitimately inactive. No SQL evidence, real credentials, DB/network/provider/config/dependency/Git actions.
Final source checks run foreground with host 180s bounds; direct compare avoids the historical launcher timeout. No further source edits after final validation.
Strict RED remains preserved original 58 diagnostics and intermediate 7 lint failures; selected typing/lint GREEN observed. No fabricated business RED or global-runtime import fix claim.
Status: bounded repair validated; global compiler remains FAIL 56, so worker handoff remains PARTIAL. Parent owns independent/native review and terminal Git actions.
