# REST-T2B independent technical verification

> Copia saneada para entrega: ubicaciones normalizadas; resultados, fechas y hashes conservan su significado histórico y corresponden al snapshot privado original, no a esta copia. WORKSPACE_ROOT identifica la coordinación; SDK_ROOT el SDK instalado; RUNTIME_ROOT las herramientas locales; TEST_ARTIFACT_ROOT los recursos privados retenidos, no publicados.


Date: 2026-10-05T11:38:26.700Z. Read-only source verification; no source edits, staging, commits, remote writes, shutdown or cleanup.

API root ${WORKSPACE_ROOT}/exom-api; coordination ../ (non-Git per writer checkpoint). Branch feat/progreso-adherencia-p4; upstream origin/feat/progreso-adherencia-p4; HEAD c383d47f4aa8217f727acf33e4c1900c0866b7bd. Initial/final short status identical: untracked docs/evidence/, scripts/probe-client-deletion-lock-order.cjs, scripts/run-followup-tasks-integration.cjs, src/modules/client-followup-tasks/. Tracked/staged diffs empty.

## Observed commands

- PASS: node scripts/run-followup-tasks-integration.cjs unit — 44 tests, 1 suite, zero pending. Receipt ../unit-60499df3-e06e-49f4-9ddd-7a6682e6abdb/jest.{json,log}.
- PASS: node scripts/run-followup-tasks-integration.cjs pg — 12 tests, 1 suite, zero pending. Receipt ../pg-d77b636e-b6e6-42be-9f9a-52c108d96c82/jest.{json,log}, resource.json, migrations.json, retained-databases.json.
- PASS: npm run lint -- --no-fix — zero errors, two warnings in unchanged progress.concurrency.spec.ts:474/482. Observed terminal output.
- PASS: npm run prisma:generate — generated client v7.10.0 into node_modules/@prisma/client; prisma-generate.log.
- PASS: npm exec -- prisma validate — valid schema, prisma-validate.log. Both Prisma commands ran through sanitized child environment using existing unit privacy preload (repository dotenv reads empty), dummy syntactically valid localhost port1 URL. No connection operation requested.
- FAIL: npm exec -- tsc --project tsconfig.build.json --outDir docs/evidence/rest-t2b-20261005/independent-build --incremental false — exit2; alternative-build.log. This is an alternative TypeScript build, NOT npm run build. nest-cli.json has deleteOutDir=true and no plugins/webpack; existing dist was not a command output target. Partial emitted output retained in independent-build.
- NOT_RUN: npm run build (prohibited deletion), full Jest repeat (not required), original deletion probe (read/hash only; would perform unauthorized cleanup).
- FAIL: first Node wrapper had a backslash-quoting SyntaxError before any npm execution or file write. Retry invoked the exact three npm commands above; no test assertions or source were changed.

## Findings

BLOCKER REST-T2B-VERIFY-BUILD-01: tsconfig.build.json has no include and excludes only node_modules/test/dist/spec files. Harness checkpoint() writes raw .service.ts copies below docs/evidence. Those are compilation inputs, and their relative common/prisma imports are absent at the copied paths. The exact authorized alternative build produced 33 TS2307 diagnostics across eleven checkpoint service copies. This is real TypeScript-build obstruction caused by evidence layout, not a Nest plugin-equivalence issue. Nothing was removed or fixed; parent must disposition before closure.

PASS hash identity: hash-check.json verifies all five current source/harness targets against final after-all-7a6a796e-b971-405a-b16a-81947c9713a4 copies/manifest; original service/spec/deletion probe also match before copies/manifest exactly. Coordination AGENTS/task/plan hashes match final manifest. Untracked candidate is independently assessable from current bytes plus checkpoints; HEAD alone is not the candidate identity.

Forced coverage is genuine: blockers start first; pg_blocking_pids proves actual service waits before release for actor/role/assignee/client/assignment revocation. Reverse ordering first blocks task row after authorization; a later users UPDATE is observed blocked. Two same-version updates and duplicate creates are observed waiting behind the client advisory barrier; final conflict/version and one-row/equal-result assertions are meaningful. These are not mere Promise.all concurrency claims.

Lock compatibility: scope obtains shared catalog/client advisory, sorted User SHARE, sorted relevant active assignment UPDATE, then owned task UPDATE. User SHARE conflicts with non-key eligibility/role UPDATE; assignment UPDATE blocks ordinary/bulk revocation. Current updateRole writes User before assignment; setClientArchived sorts User UPDATE before assignment SHARE; deletion request takes advisory before sorted User UPDATE. Their relevant first-row orders align with this service. syncClientAssignments uses unsorted updateMany over potentially multiple assignments; row conflicts protect authorization, but global deadlock freedom for multi-row bulk order is not proved here.

Coverage limits (not newly demonstrated service defects): new PG tests use raw conflicting row writers rather than invoking complete production writer transactions; reverse test title says role writer but SQL writes is_active. It covers only one later writer, not full bulk/role/archive/deletion transactions or their post-lock work. blocked() counts waiters without recording operation-specific PID/query; controlled isolated suite makes waits meaningful but receipt is not a complete lock graph. Same-version case checks one conflict and persisted winner but lacks explicit successful outcome assertion. SUPER_ADMIN ineligible-assignee branch deactivates the actor itself, so that particular rejection cannot independently prove assignee validation. All non-task table snapshots prove absence of mutation on fixtures (body metric populated); most historical/planning/outbox tables are empty, so this is not broad populated-history migration coverage.

Owner/auth/replay/version/history source review: owner and creator are internal; owned queries constrain id/client_id; actor database role/flags and explicit assignee/assignment are revalidated in transaction after locks. Same UUID normalized payload/creator/owner/version1 replay is accepted; changed payload/creator/owner or updated/closed task conflicts without returning another owner's row. expected_version predicate plus locked task/increment prevents lost update and overflow; closed task modifications conflict. Unrelated edits preserve null/stale historical assignee; archive reads retain task and writes are forbidden. Only task table mutations occur in this internal service; no notifications/outbox/external clients invoked. No HTTP/module integration claim.

Harness isolation assessed before running: fresh random labelled Docker container, dynamic loopback port, inspected full ID/name/label/running/PGDATA/tmpfs/no binds; SQL database/role/data-directory and empty public schema checked before SQL migration/fixture writes. Sanitized environment prevents production URL fallback. PG fixture resets are inside this fresh owned cluster; no row/container/database cleanup performed. Only connection/transaction release occurs. Outputs are expected evidence/checkpoints, authorized node_modules generation and independent-build emit; no unexpected tracked mutation observed.

Retained new container: exom-rest-t2b-6d23ef3c-293c-4ecf-9c8a-c9092023a536; ID 192a6aaa901b5a2c2b87e776c535583377903e5c8ebfb6b06639feb2ba983503; 127.0.0.1:60814; database/role exom_ci; data-directory /var/lib/postgresql/exom-ci-data. Do not delete/stop it.

Disposition: bounded service tests and source review support correctness, but technical closure BLOCKED by observed build failure. No next-unit implementation authorized. Engram memory tools unavailable in this verifier tool surface; this evidence is the recoverable handoff.
