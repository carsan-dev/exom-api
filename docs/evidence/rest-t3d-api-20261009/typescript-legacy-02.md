# TSC-LEGACY-02 — bounded typing receipt

> Copia saneada para entrega: ubicaciones normalizadas; resultados, fechas y hashes conservan su significado histórico y corresponden al snapshot privado original, no a esta copia. WORKSPACE_ROOT identifica la coordinación; SDK_ROOT el SDK instalado; RUNTIME_ROOT las herramientas locales; TEST_ARTIFACT_ROOT los recursos privados retenidos, no publicados.


Date: 2026-10-09. Status: PARTIAL; unit tooling repaired, independent gates pending.
Repo: `${WORKSPACE_ROOT}/exom-api`.
Coordination root: `${WORKSPACE_ROOT}/` (unversioned).
Base: `7d14b96bb625eb4e8c1a2183fa57b5661350fc13`, branch/upstream
`feat/progreso-adherencia-p4` / `origin/feat/progreso-adherencia-p4`;
merge base `c383d47f4aa8217f727acf33e4c1900c0866b7bd`.

## Contract and scope

The five locked-day callers return objects. The generic now requires objects
and exposes optional `operation_revision?: Prisma.JsonValue`: fresh commands
return numbers, legacy calls need not include the field, replay JSON is not
validated as numeric. The existing replay assertion remains a limitation;
this change does not validate replay payloads or change responses/serialization.
The test helper includes the existing optional string session identity.
Fail-fast guards require a real unmark row and numeric fresh-command revisions.
All original assertions, cases, barriers and timeouts remain unchanged.

## Commands and observed evidence

Artifact root `T`: `${RUNTIME_ROOT}/AppData/Local/Temp/exom-api-tsc-legacy-20261009-02`.
Commands below run from the API root; expand `T` literally.

- `node node_modules/typescript/bin/tsc --project tsconfig.json --noEmit --incremental false --pretty false`: global FAIL, exit 2, 37 remaining diagnostics; 19 resolved, zero new. Remaining messages, codes, paths and positions exactly match the prior 56-diagnostic log after removing the selected cluster. See `T/tsc.log` and `T/proofs.json`.
- `node T/proofs.cjs`: PASS, production emitted JavaScript hash identical before/final: `a32b4d30863fb63f48082805f74765c21a12192e9b964bc30058796bd5d80b09`. All 292 assertion AST texts and case/parameter texts identical; static expansion 37.
- `node node_modules/eslint/bin/eslint.js src/modules/progress/progress.service.ts src/modules/progress/progress.concurrency.spec.ts --no-fix`: PASS, exit 0, no warnings/errors; `T/eslint.log`.
- `node T/run-progress-pg.cjs --self-check`: PASS, valid exact-37 report, nine invalid reports and three unsafe URLs rejected.
- `node T/run-progress-pg.cjs`: final candidate PASS, 37/37 cases, zero failed/pending/todo/open handles; 92 migrations applied. Report/receipt: `${RUNTIME_ROOT}/AppData/Local/Temp/exom-archive-pg-vQSFpv/{jest,manifest}.json`.
- Original `node T/run-unit.cjs`: FAIL before Jest loaded; Windows preload backslashes stripped, `MODULE_NOT_FOUND`. At that point required 44-case unit suite NOT_RUN, not PASS. Original `T/unit.log` and copied `T/run-unit.failed.cjs` preserve the incident.
- Fixed `node ${RUNTIME_ROOT}/AppData/Local/Temp/exom-api-tsc-legacy-20261009-02/run-unit.cjs`: PASS, executed once, 44/44 cases, zero failed/pending/todo/open handles. Jest start UTC `2026-10-09T06:56:58.622Z`; result/pin check UTC `2026-10-09T06:58:11.811Z`. Reports: `T/unit-fixed.json`, `T/unit-fixed.log`. Quoted forward-slash `NODE_OPTIONS --require` fixes Windows encoding; guard unchanged, sterile CI=false/test environment and output/cache paths stay OWN. No PostgreSQL/compiler rerun.
- Tooling RED: preserved actual pre-Jest `MODULE_NOT_FOUND`; GREEN: actual fixed 44-case pass. Existing 01c/01e sterile launchers compared; 01c has no `run-unit.cjs`, its `launch.cjs` was inspected instead.
- Fixed unit launcher SHA256 `1867fe5512b7f0d7c02f0dc311de27beb82cb0f53b9369d9f3195489cdd465cd`; unchanged unit spec SHA256 `009adb24102755b328b5fdaff61349948acae4b66602e42a9b363cb9f02fc17e`.
- Post-fix ESLint command above: PASS, exit 0. Hash-only before/after check: all source/guard/PG-launcher/probe/plan/AGENTS/foreign-cache pins unchanged (`T/unit-fixed-before.json`).
- `git diff --check`: PASS. Final manifest records source/document hashes and checkpoint patch.

RED was the verified existing compiler log, SHA256 `e96bce52789d2d28a7c04810015a3b3ad414acd790eb0d4fc660be80b9dec563`, under `exom-api-tsc-legacy-20261009-01e/verify3-independent/tsc.log` in OS Temp. No invented business RED.
Initial candidate compiler FAIL38 and lint FAIL3 preserved under `T/initial-*`; final results supersede them, not their history. Initial PostgreSQL PASS37 receipt `exom-archive-pg-9v4n0l/manifest.json` does not pin final test guards; that group remains retained.

## Isolation, pins and preservation

Final owned nonce `archive-1791528654043-13d2e11556b5`, container
`exom-archive-1791528654043-13d2e11556b5`, same name plus `-data` volume;
loopback port 59873. Cached PG17 image with pull-never, fresh owned volume,
container/image/mount/label checks and SQL database/user `exom_ci`, data directory
`/var/lib/postgresql/exom-ci-data`, empty public schema verified before DDL.
Original network guard allows only the owned PG, denies external providers;
credentials stay in process environment, never in logs or this receipt.
Original launcher and database guard are unchanged. Copy changes only root,
dependency resolution, target, exact report count/self-checks and candidate pins.
Launcher SHA256 `d71e78f8482aa9dc1f7209c9022369ad2a4304b4d7bacf98785508f55849f87c`.
Before/final source pins: `T/before.json`, `T/proofs.json`, `T/candidate-pins.json`.
Final service SHA256 `372897ebd2312a2a08669c06464cc9c59e84fec54718ad14fcd334df92462ae2`.
Final spec SHA256 `5286db846084d90e48f18322836f863925a608a960987e13f80da1b089f03657`.
Root AGENTS/plan, unrun probe and four foreign cache files unchanged by hash-only
before/after comparison; `T/preservation.json`. No foreign cache contents read.
No cleanup, deletion, commits, dependency/cache mutation or production access.

## Remaining gates

Independent verification pending: `node T/run-progress-pg.cjs` starts another
fresh nonce group; do not reuse retained groups. Check launcher SHA256 first.
Unit tooling incident resolved; bounded self-verification is not independent/native review.
Parent owns independent/native review, tracking and terminal Git actions.
Global typecheck still FAIL37; this receipt does not close P5 or claim deployment.
Final recovery manifest: `T/final-manifest.json`; explicit filename/SHA256 entries include this document without a self-hash cycle. Original baseline retained as `T/final-manifest.before-unit-fix.json`, SHA256 `f95e3e48607be98087fe798eaeaa283c276706adbb14b427bfaa25d74f5facfb`. Original failed logs/runner retained; no results fabricated.
