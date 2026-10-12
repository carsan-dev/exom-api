# Corrected REST-T2B — independent verification

> Copia saneada para entrega: ubicaciones normalizadas; resultados, fechas y hashes conservan su significado histórico y corresponden al snapshot privado original, no a esta copia. WORKSPACE_ROOT identifica la coordinación; SDK_ROOT el SDK instalado; RUNTIME_ROOT las herramientas locales; TEST_ARTIFACT_ROOT los recursos privados retenidos, no publicados.


Date: 2026-10-05T11:58:12.922Z. Supersedes prior verifier build-blocker disposition for this corrected candidate only; previous findings/logs/failures remain preserved. This is independent technical verification, NOT native review approval/substitution and NOT full P5/REST-T2 closure.

## Candidate identity
API root ${WORKSPACE_ROOT}/exom-api; branch/upstream feat/progreso-adherencia-p4 / origin/feat/progreso-adherencia-p4; HEAD c383d47f4aa8217f727acf33e4c1900c0866b7bd. Initial/final short status unchanged: untracked docs/evidence/, scripts/probe-client-deletion-lock-order.cjs, scripts/run-followup-tasks-integration.cjs, src/modules/client-followup-tasks/. Empty tracked/staged diffs. Coordination AGENTS/task/plan hashes match writer final; no coordination edits.

Corrected writer checkpoint: after-all-f95da048-9666-4283-8e0d-ed2e4446a3c4/manifest.json. Current SHA256 matches:
- src/modules/client-followup-tasks/client-followup-tasks.service.ts: a3522bb55c67f372b8dccbae9f8ac26ec875e331e01619933110a28284cd1d67
- src/modules/client-followup-tasks/client-followup-tasks.service.spec.ts: 8a8c05f822e948c51e240ba7e8735a4069175c03457df8da2bd695248437a8e7
- scripts/probe-client-deletion-lock-order.cjs: 8b5ba61a1cf147c643727dbfb2f7139126e6f08647906bb7cf5ad9004ddc8ac4
- scripts/run-followup-tasks-integration.cjs: fe5268ca50fb78a22fb3fd918bdf3551013241aa871e15fd3d30f49a954f251c
- src/modules/client-followup-tasks/client-followup-tasks.pg.spec.ts: 9cd76e4e88c853bd8fa679e6307f30e1378e075ef22eed4ce8778656807f8dd5

Original service/spec/probe also match before manifest and original preserved copies. Hash audit PASS: 888 rename-inventory entries, 77 checkpoint entries, all 906 .ts.snapshot files covered; zero missing/mismatched/uncovered snapshots. Full reproducible paths/expected/actual hashes in corrected-hash-audit.json. Renames preserved original bytes; original historical copies and compiler artifacts remain retrievable. No evidence deletion performed.

## Fresh observed checks (not old receipts)
- PASS node scripts/run-followup-tasks-integration.cjs unit — 1 suite/44 tests, zero pending; unit-acf0bd37-54e6-4abe-bee1-f73373079491/jest.log and jest.json.
- PASS node scripts/run-followup-tasks-integration.cjs pg — 1 suite/12 tests, zero pending; pg-9e745ee4-9f53-48ff-940c-96ba4744e111/jest.log, jest.json, resource.json, migrations.json, retained-databases.json.
- PASS node scripts/run-followup-tasks-integration.cjs all — 106 suites/1228 tests, zero pending; all-db49d3c4-8575-4a05-83ca-1b43605ee1f4/jest.log, jest.json, resource.json, migrations.json, retained-databases.json.
- PASS npm run lint -- --no-fix — exit0, zero errors, same two warnings progress.concurrency.spec.ts:474/482; corrected-independent-lint.log.
- PASS npm exec -- tsc --project tsconfig.build.json --outDir docs/evidence/rest-t2b-20261005/final-independent-build --incremental false — exit0/no diagnostics; final-independent-build.log. Nondeleting alternative TypeScript build, NOT Nest build. No Nest plugins/webpack configured. Output retained in final-independent-build; its fresh declarations are expected build outputs, not checkpoint source copies.

Harness modes ran sequentially using their allowlisted environment, blank dotenv and privacy preload, fresh random owned PG, exact container/SQL identity and empty schema gates before writes. Lint/build used sanitized child environment with only OS/path keys, the new unit receipt privacy preload/empty.env and syntactically valid localhost port1 dummy URL; no dotenv credentials used/exposed. No Prisma repeat requested in this correction verification: NOT_RUN here; prior independent generation/validation PASS remain recorded with unchanged schema/config. npm run build NOT_RUN/prohibited; deletion probe NOT_RUN/unauthorized cleanup.

## Corrections and review disposition
REST-T2B-VERIFY-BUILD-01 RESOLVED by independent fresh build PASS: evidence TypeScript copies now have noncompilable suffixes, compiler config/service unchanged. Harness writes safe future checkpoints. Every historical renamed byte checked against receipt hashes.

Reverse authorization race now actually updates role='CLIENT'. Service first demonstrably waits on held task row after User SHARE/assignment authorization locks; later role UPDATE demonstrably waits; releasing task permits authorized version2/title write; writer succeeds and commits; stale ADMIN access is then ForbiddenException. Ineligible SUPER_ADMIN assignee uses the separate active assigned ADMIN actor, eliminating actor-invalidity masking. Every one of four eligibility flags is covered independently for that assignee.

Existing five revocation races prove wait via pg_blocking_pids before commit, then ForbiddenException and unchanged task version. Duplicate creates and same-version contenders require two observed waits behind client advisory barrier; duplicate results/one row and one conflict/version2 are meaningful. Owner isolation, creator/payload/owner replay collisions, overflow, immutable closed tasks/timestamps, archived historical reads and null legacy assignee remain covered. Production User and assignment row conflicts/order compatibility remain supported by prior source review; untouched service source hash means that analysis is still applicable.

Remaining evidence limits, not newly demonstrated defects: raw SQL writers rather than full production writer transactions; multi-row unsorted bulk-assignment deadlock freedom not demonstrated; wait helper counts sessions rather than retaining operation-specific lock graph; same-version case still does not explicitly classify fulfilled winner outcome although persisted version2 proves committed winner; most protected history tables empty in no-side-effects snapshots (metric populated). No claim of migration/populated-history comprehensive verification, HTTP/module/shared projections/client compatibility or later units.

Technical disposition: PASS for corrected bounded REST-T2B independent verification; prior build blocker resolved. No known new service defect or failed required command in this correction verification. Native review remains separately pending/blocked/unrelated and is NOT approval; parent owns final scoped closure and any next authorized work.

## Newly retained resources
PG name exom-rest-t2b-247b0ded-5995-4e32-9e3b-0e6260c26290; ID 80bd3e1e456cc61e6d0d72cc6ecb172aabbfc6dfa04194f228b4d3fedddadb75; loopback56875.
ALL name exom-rest-t2b-3f1e0f41-864a-4aea-9da9-e85f40ea081c; ID 96bea0f4a87ca2135be1de4a34df68e06984b61fbd9eb07768288ad5e5e27431; loopback49540.
Both database/role exom_ci; PGDATA /var/lib/postgresql/exom-ci-data. Full mode retains 12 databases including 9 legacy clones/template/postgres/main; see inventory. No stop/remove/drop/cleanup command, remote write, source edit, commit or next-unit implementation. Prior resources/logs/failures untouched. Memory tools unavailable; this dated report is the checkpoint handoff.
