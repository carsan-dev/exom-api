# TSC-LEGACY-01C — progress mock arguments

> Copia saneada para entrega: ubicaciones normalizadas; resultados, fechas y hashes conservan su significado histórico y corresponden al snapshot privado original, no a esta copia. WORKSPACE_ROOT identifica la coordinación; SDK_ROOT el SDK instalado; RUNTIME_ROOT las herramientas locales; TEST_ARTIFACT_ROOT los recursos privados retenidos, no publicados.


Date: 2026-10-09. Scope: P5; implementation validated, independent/native review pending.
Repository: ${WORKSPACE_ROOT}/exom-api
Base/source HEAD: ecdc9677612477b6cee6dc6546aaf68c1a9adce9
Branch/upstream: feat/progreso-adherencia-p4 / origin/feat/progreso-adherencia-p4.
Preserved untracked probe and %SystemDrive% caches; no commit or delivery operation.

## Change and RED
The upsert mock incorrectly described only update.exercises_completed.
Prisma/service writes require where/create/update and support meal updates.
Both mock generics now use Prisma.DayProgressUpsertArgs via a type-only import.
No assertions, fixtures, production, dependencies, config, SQL guards or DB resources changed.
Strict compiler RED: prior 01b/verify2/tsc.log, 63 diagnostics, exit 2.
Selected original failures: TS2345 at 135:7 and 351:9; TS2339 at 147:55; TS2353 at 1907:9.
Baseline log SHA256: fa46eedf8b7077768c3c7ffde34a5b128e3601283b4407e97b9bd8751903539e.
Type-only correction: no invented behavior RED.

## Final validation
Artifact root T: ${RUNTIME_ROOT}/AppData/Local/Temp/exom-api-tsc-legacy-20261009-01c/
Runner L: T/launch.cjs. Commands below ran in foreground as node L <mode> <suffix>.
Final suffix: writer-final; baseline snapshot: writer; sealed final pins: writer/final.json.
Underlying compiler: node node_modules/typescript/bin/tsc --project tsconfig.json --noEmit --incremental false --pretty false
Result: global FAIL, exit 2, 59 diagnostics. Selected compiler GREEN: exactly four resolved, zero new.
node L compare writer-final: PASS; all remaining path/line/column/code/full messages identical.
node L jest writer-final: PASS; original Jest config/setup, whole spec, 44/44 cases, zero skipped.
Underlying Jest: node node_modules/jest/bin/jest.js --runInBand --runTestsByPath src/modules/progress/progress.service.spec.ts --cacheDirectory T/writer-final/jest-cache --json --outputFile T/writer-final/jest.json
node L lint writer-final: PASS, exit 0, no warnings.
Underlying lint: node node_modules/eslint/bin/eslint.js src/modules/progress/progress.service.spec.ts --no-fix
Emitted JS identity (source maps excluded): SHA256 240bb7c6a31b5b6b461cbe79889791454af6dcc9f590e7bad4ec049335d22c92 before/after.
Runtime AST assertion/case/data identity and annotation-only restoration: PASS.
Preserved source/config/generated-client/prior probe/cache pins: PASS. git diff --check: PASS.
Sterile allowlisted environment: CI=false, NODE_ENV=test, owned empty.env and writable caches.
No inherited secrets; real dotenv/network denied by copied minimal guard; all final guard events/ports empty.
Original setup DB condition inactive for units; this is NONDB evidence, not SQL proof.
Retained initial writer comparison FAIL (AST mistakenly included type arguments); repaired runtime AST comparison passed.
Retained initial writer lint FAIL (two declaration-format errors); local formatting fixed; final checks rerun.
Initial and final compiler logs retained; no previous TEMP outputs overwritten.

## Hashes and independent reproduction
Source SHA256: 009adb24102755b328b5fdaff61349948acae4b66602e42a9b363cb9f02fc17e
launch.cjs SHA256: 434b30908e301703a35b2e987c9a60474293ee5c9cc788a1864d18754dd54237
Copied guard.cjs SHA256: 03de49e51bee5fb2ce0ea0ba6a7e1a70c528153f5281dce45a4a7ad785339998
writer/manifest.json SHA256: c8dd0b190d9f495fbc18bbbc6d00f7bfcbaace64ce55ad56692c10f9ee0fb7db
writer/final.json SHA256: 6352e0786cbce0086ee65712f6e17f824821896c4e6f8cea138f4e31f3be510e
writer-final/tsc.log SHA256: af3682183e20514f80707b0b60b5187bfc6b23d8273446328c21a78d400f98ff
writer-final/comparison.json SHA256: 12642ed548e4da356bebae0898d717dd2c3cacba4a7ea17fb8da8d1574277a63
manifest.json is BEFORE source; final.json is FINAL source. Independent snapshot checks FINAL, not baseline.
Pin-role smoke: node L snapshot pincheck: PASS. No independent test run claimed.
Independent foreground commands (replace L with its exact path above):
node L snapshot verify3; node L tsc verify3; node L compare verify3; node L jest verify3; node L lint verify3
Use a fresh independent suffix if verify3 exists. Expected compiler exit 2 remains intentional global FAIL.
Native/independent disposition belongs to parent; no review status consumed or produced.
