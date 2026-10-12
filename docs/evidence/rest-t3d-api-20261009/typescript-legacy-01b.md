# TSC-LEGACY-01B — recap mock update contract

> Copia saneada para entrega: ubicaciones normalizadas; resultados, fechas y hashes conservan su significado histórico y corresponden al snapshot privado original, no a esta copia. WORKSPACE_ROOT identifica la coordinación; SDK_ROOT el SDK instalado; RUNTIME_ROOT las herramientas locales; TEST_ARTIFACT_ROOT los recursos privados retenidos, no publicados.


Status: scoped implementation and writer validation COMPLETE; independent/native review and Git delivery pending with parent.
Date: 2026-10-09. Root: `${WORKSPACE_ROOT}/exom-api`.
Base: `6356f3b88c65ed2521fa364d3502378dcddc0d94`, branch `feat/progreso-adherencia-p4`, upstream `origin/feat/progreso-adherencia-p4`.

## Change and boundary

Both `weeklyRecap.update` mock argument declarations now require `where: Prisma.WeeklyRecapUpdateArgs['where']`.
Installed Prisma 7.10.0 defines that property as `WeeklyRecapWhereUniqueInput`, including `id`, `client_id`, and `status`; production already supplies it.
This is a test type gap, not a production bug. Existing `data`/`select` types, assertions, fixtures, and all cases are unchanged.
The existing runtime `Prisma` import also supports DMMF; no new import or runtime operation was needed.
Two tuples needed short multiline wrapping for style (14 additions, 2 removals); no unrelated formatting.
No production/config/schema edits, SQL, deletion, staging, commit, remote action, or coordination-root writes.

## Evidence and commands

Owned evidence root (`E`): `${RUNTIME_ROOT}/AppData/Local/Temp/exom-api-tsc-legacy-20261009-01b`.
Immutable baseline: `${RUNTIME_ROOT}/AppData/Local/Temp/exom-api-tsc-legacy-20261009-01a/verify/tsc.log`.
Baseline SHA-256: `fcfdd5b212b482471753934c97b24a9ca87d2827896ea0d604cc95755d5ca7da`.
Launcher: `E/launch.cjs`; copied guard: `E/guard.cjs` (87 total lines, no new framework).
Observed wrapper invocations: `node E/launch.cjs snapshot writer`, then `jest writer`, `lint writer`, `tsc writer`, `compare writer` in the foreground.
`E` is the absolute path above, not a literal command variable. Exact child commands are pinned in `E/writer/manifest.json`:

- `node node_modules/jest/bin/jest.js --runInBand --runTestsByPath src/modules/recaps/recaps.service.spec.ts --cacheDirectory ${RUNTIME_ROOT}/AppData\Local\Temp\exom-api-tsc-legacy-20261009-01b\writer\jest-cache --json --outputFile ${RUNTIME_ROOT}/AppData\Local\Temp\exom-api-tsc-legacy-20261009-01b\writer\jest.json`: PASS, exit 0; 1 suite, 25/25 cases, no skipped/failed cases.
- `node node_modules/eslint/bin/eslint.js src/modules/recaps/recaps.service.spec.ts --no-fix`: PASS, exit 0, no diagnostics.
- `node node_modules/typescript/bin/tsc --project tsconfig.json --noEmit --incremental false --pretty false`: global FAIL, exit 2; 63 errors remain OPEN, not waived.
- `git diff --check`: PASS.

## Type RED/GREEN and preservation

No new behavior TDD: this annotation-only change uses the parent's observed baseline, not a repeated RED ritual.
RED: baseline had 70 diagnostics, including seven TS2353 errors at original lines 235/282/327/367/414/476/618.
GREEN (selected scope only): exactly seven removed, zero added; all remaining 63 match path/code/line/column/full message exactly.
Diagnostic files: actual 20 before, 19 after. Historical 83/23 was corrected to 83/22; 01A produced 70/20.
`E/writer/comparison.json` records the semantic comparison, original-byte restoration, and byte-identical AST case/assertion texts.
Installed TypeScript transpilation used the actual tsconfig options with Jest's CommonJS module target; before/after runtime JS SHA-256 both `d1274d37c38f0bb64a2ab77979bef843f6326392df7963951be8c84b98697e51`.
Spec SHA-256 before: `e3a562587487203f44190806ba9fe7bbe4d3d2f3a14386f9d30139725576b4a6`.
Spec SHA-256 after: `f1d26ea1b211afd84d8e5af1bd33061705fd4ec29d15daf7694269e98b7c8c80`.
All other prior source pins match, including earlier 01A specs, lock-order production/regressions/receipt, probe, and four foreign metadata files; package/config/setup/generated declarations and the 01A receipt were also pinned unchanged.
Unit setup/config/selection remained original. Sterile whitelist used `CI=false` without database/provider credentials; original conditional SQL verification was legitimately inactive for this NONDB suite.
All three guard reports have zero denials and zero live ports. The copied guard is focused isolation evidence, not a universal Node sandbox claim.
`E/writer/evidence-summary.json` contains counts, hashes, and guard report names; logs/result JSONs preserve all command outcomes.

## Independent handoff

Manifest SHA-256: `914128d13f708bd0823edb6425ad1d00f5713c7ff3db63963e81d2b63d883e71`.
Pinned command-object SHA-256: `124ff22d95a4d2afc0143019bedd698c636a381e05c5efc9571c6b1f7ab287df`.
Launcher SHA-256: `390bf6f20a2fd7d5e6cfccb7792678cd2f41a26b1e14aed66ceea756a2337a1d`.
Guard SHA-256: `03de49e51bee5fb2ce0ea0ba6a7e1a70c528153f5281dce45a4a7ad785339998`.
Standalone verifier: run `node ${RUNTIME_ROOT}/AppData/Local/Temp/exom-api-tsc-legacy-20261009-01b/launch.cjs jest verify`, then the same absolute launcher with `lint verify`, `tsc verify`, and `compare verify` (do not snapshot over the original writer manifest).
The compiler's expected exit 2 must not prevent the subsequent comparison; outputs use a fresh `verify` suffix and never overwrite prior evidence.
Only this spec and this passive receipt are candidate files. Parent owns independent/native disposition, coordination tracking, and terminal Git actions; no review receipt is claimed here.

## Snapshot tooling repair — 2026-10-09

Strict TDD source: parent-forwarded harness default policy for deterministic metadata behavior.
RED: parent independently observed `snapshot verify` exit 1, `Prior source pin mismatch`; its empty `E/verify` and all writer artifacts remain untouched.
Cause: verification compared the intentionally changed exact recap spec to its old baseline pin, not its authenticated final pin.
Repair: authenticate writer manifest, summary and final-file record; require final SHA for this exact target only, original pins for every other file, and exact HEAD `6356f3b88c65ed2521fa364d3502378dcddc0d94`.
Original launcher preserved byte-identically as `E/prior-repair.cjs`; no source, guard, assertions, comparer or compiler/test arguments changed.
GREEN: actual `node E/launch.cjs snapshot repaired` PASS; then `jest repaired` PASS 25/25, `lint repaired` PASS no-fix, `tsc repaired` FAIL exit 2, `compare repaired` PASS; each once, foreground, 180-second timeout.
All 63 global diagnostics remain OPEN: seven removed, zero added, remaining path/code/line/column/full message identical; runtime and case/assertion bytes identical; other pins preserved.
Spec before/after repair SHA remains `f1d26ea1b211afd84d8e5af1bd33061705fd4ec29d15daf7694269e98b7c8c80`; three guard reports have empty events/livePorts, not a universal sandbox claim.
New launcher SHA: `f6059d8ef96e32313c5c7726a04f4b95155bd0b825f2b74532bba6c925398852`; snapshot manifest SHA: `bed06dc4bb81d0281ddfef5e7288cbfc7146ccd005c46fa8c021f403916458c4`.
Comparison SHA: `5db7a9b3c0d130973203ef8026c255d82b59f8d8efd6b7b76369892d5e609556`; guard remains `03de49e51bee5fb2ce0ea0ba6a7e1a70c528153f5281dce45a4a7ad785339998`.
Repaired command SHA: `9886bbc9ec03c098d4dcefff338a35c91637e64aa2732f95606dd1e125fd5a8e`; normalizing only owned output paths to writer reproduces original `124ff22d95a4d2afc0143019bedd698c636a381e05c5efc9571c6b1f7ab287df`.
Sealed fresh command outcomes/log hashes/guard records: `E/repaired/evidence-summary.json`; final receipt/source hashes: `E/repaired/final.json`. Raw stdout/stderr remain in owned logs.
Independent fresh verification: `node ${RUNTIME_ROOT}/AppData/Local/Temp/exom-api-tsc-legacy-20261009-01b/launch.cjs snapshot verify2`, then same absolute launcher with `jest verify2`, `lint verify2`, `tsc verify2`, `compare verify2`; output role is post-edit verification, not writer baseline.
This tooling repair does not close P5, critical catalog/request/history work, or global TypeScript debt; parent retains independent/native review and Git ownership.
