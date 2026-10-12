# TSC01D — bounded generic history-cut fixture correction

> Copia saneada para entrega: ubicaciones normalizadas; resultados, fechas y hashes conservan su significado histórico y corresponden al snapshot privado original, no a esta copia. WORKSPACE_ROOT identifica la coordinación; SDK_ROOT el SDK instalado; RUNTIME_ROOT las herramientas locales; TEST_ARTIFACT_ROOT los recursos privados retenidos, no publicados.


Date: 2026-10-09. Scope: one fixture; production and assertions unchanged.
Base: d2604a59e7652096e6d42df1a47aacca4e78847d.
Root: ${WORKSPACE_ROOT}/exom-api.
Branch/upstream: feat/progreso-adherencia-p4 / origin/feat/progreso-adherencia-p4.
Initial status: only untracked `%SystemDrive%/` and `scripts/probe-client-deletion-lock-order.cjs`; preserved.
Coordination RootCURRENT/mirror539 before-write tracking supplied by parent; no coordination edits.

Root cause: installed @types/jest fn<T,Y> models one return type, erasing the
callback generic to Promise<unknown>; the real provider requires Promise<T>.
The original mock remains observable and overridable. The origin now exposes a
true generic method capturing work's Promise<T>, without casts or unknown conversion.
Runtime added: capture plus completion.then; emitted JavaScript is NOT identical.
Work still starts synchronously once on the same session; exact resolved values,
callback rejection, synchronous throw and mock rejection propagation are preserved.
Promise identity/microtask count are not claimed identical. No production guarantee added.

RED: reused actual 59-diagnostic 01c/verify3/tsc.log, SHA256
`af3682183e20514f80707b0b60b5187bfc6b23d8273446328c21a78d400f98ff`.
Selected TS2322: history-cut.spec.ts(24,5); generic callback declared at 16–18.
GREEN: selected TS2322 removed; compiler remains GLOBAL FAIL, exit 2, 58 diagnostics.
Comparison: exactly 1 removed / 0 added; all 58 full messages/codes/paths/positions
identical, with no line-shift normalization needed. Ledger PrismaPromise failure retained.
All original 13 history-cut cases PASS; zero skips; original Jest config/setup used.
AST original assertions/data outside fixture identical; diff changes only provider method.
Original/final fixture proof PASS: undefined/number/object identity, immediate callback,
call tracking, callback rejection, synchronous throw, and mockRejectedValue suppression.
ESLint --no-fix PASS; git diff --check and terminal EOF check PASS.
Isolation: CI=false, NODE_ENV=test, empty owned dotenv, environment allowlist,
owned Windows/cache paths; deny network/real dotenv reads/outside writes; 3 guards had no events.
NONDB static fixture verification only: original setup's CI/TEST_DATABASE_URL gate inactive.
No PostgreSQL/schema/build/full-suite/provider/real-env operation; not SQL proof.

Artifacts root A: ${RUNTIME_ROOT}/AppData/Local/Temp/exom-api-tsc-legacy-20261009-01d/.
Commands actually run: `node A/launch.cjs before writer`, then `seal writer`,
`tsc writer`, `compare writer`, `jest writer`, `lint writer`, `proof writer`, `snapshot writer`.
Compiler subprocess: `node node_modules/typescript/bin/tsc --project tsconfig.json --noEmit --incremental false --pretty false`.
Jest subprocess: `node node_modules/jest/bin/jest.js --runInBand --runTestsByPath src/modules/adherence/adherence-history-cut.spec.ts --cacheDirectory A/writer/jest-cache --json --outputFile A/writer/jest.json`.
Lint subprocess: `node node_modules/eslint/bin/eslint.js src/modules/adherence/adherence-history-cut.spec.ts --no-fix`.
Source SHA256: `8a9bdb3122aa97843e59fa380d02d8fab7038c74cf7c7d6e024eda661f441bed`.
A/launch.cjs SHA256: `33aa25aa8f84ace889f755bf1e63f7e3e3a8a1cdd6d2b13febafac9a9f3ad274`.
A/guard.cjs SHA256: `bec804a725cd5bef72fa224bf329e41bd13e48a12e653619966fea08c71ad806`.
A/writer/BEFORE.json SHA256: `60841a91228c2ca4a767ac7010e97890bff754d57839848f673aa7ac015a23a6`.
A/writer/FINAL.json SHA256: `b24e3baea39a72c5cbf3964ee7edf97cf058710411e9e115132f2136f8c5fcab`.
A/writer/manifest.json SHA256: `5a49ec642ebea1b894d1d32e94727e0fb05de7f19bb4b8b5e34692e4ece59c68`.
A/writer/tsc.log SHA256: `c4d6490ae582125ce2f30435c9b3e8e842629c50aac60663e8bf9e7f6a076524`.
A/writer/jest.log SHA256: `98c663c2253a310325cff815e068770b04c7c67458ba189ded2775ac8eaa59bf`.
A/writer/lint.log SHA256: `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
A/writer/comparison.json SHA256: `34da8b8d48b3af0dcb27b082282be39d4c7f5055e0e76e7970dab416cd2d169b`.
A/writer/callback-proof.json SHA256: `a2d3765d9c2fd43a6b96332d0a6d9e05436d1532548176e4a30d27c3138915ed`.
BEFORE pins are historical; fresh snapshots/commands enforce FINAL source and tool pins.
Independent parent verification: use fresh suffix verify1, run snapshot, tsc, compare,
jest, lint, proof in foreground, each as `node A/launch.cjs <mode> verify1`.
Independent commands are instructions, not claimed writer executions. No commit/review performed.
