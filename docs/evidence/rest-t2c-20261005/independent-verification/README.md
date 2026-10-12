# REST-T2C independent technical verification
UTC 2026-10-05T13:46:52.212Z

PASS bounded HTTP/module verification; native review separate pending. No source/harness/config/task/prior-receipt edits, commits, remote/lifecycle/cleanup operations.

## Exact fresh checks
Runner commands used FOLLOWUP_EVIDENCE_ROOT=docs/evidence/rest-t2c-20261005 and ran sequentially. Sanitized allowlisted child environments, blank dotenv/privacy preload, fresh labelled owned PostgreSQL; exact mount/loopback/container/SQL identity and empty schema verified before writes. ALL prepares owned legacy84/timestamp-off prerequisites. No T2B scans or old receipt rewrites.
PASS node scripts/run-followup-tasks-integration.cjs http — 1 suites/46 tests/pending0; http-b795ce3c-e17e-4ce8-ba7f-f871a4c7e111/jest.log + jest.json.
PASS node scripts/run-followup-tasks-integration.cjs unit — 1 suites/44 tests/pending0; unit-66ae3a03-1426-42e3-8229-f4f35117ffb2/jest.log + jest.json.
PASS node scripts/run-followup-tasks-integration.cjs pg — 1 suites/12 tests/pending0; pg-b3fb7ee7-5545-4d1b-9b7c-a3c0e6c8c522/jest.log + jest.json.
PASS node scripts/run-followup-tasks-integration.cjs all — 107 suites/1274 tests/pending0; all-3e6bff5e-8ffb-4cad-8f06-978e42b852d7/jest.log + jest.json.
ALL JSON independently confirms HTTP46 assertionResults all passed, zero pending. Concurrent HTTP contenders require observed blocker graph and exactly [200,409]; persisted version2/title matches winner.
PASS npm run lint -- --no-fix — zeroerrors/two unchanged warnings474/482; lint.log.
PASS npm exec -- tsc --project tsconfig.build.json --outDir docs/evidence/rest-t2c-20261005/build-independent --incremental false — exit0/no diagnostics; build.log. Nondeleting TypeScript alternative NOT Nest build; no plugins/webpack.
Lint/build env clears inherited app variables, keeps OS/path keys, NODE_ENV=test, new HTTP privacy/empty.env, explicit unused localhost port1 DB URLs. No production/live Firebase fallback.
PASS git diff --check; diff-check.log, tracked.patch. Schema/config/package/lockfile diff empty at same HEAD; prior PrismaPASS applicable. Prisma/Nest build/native NOT_RUN here.
One receipt-writing wrapper SyntaxError occurred before any writes; retried shorter wrapper. No test/source correction.

## Identity
hash-audit.json + safe snapshots/ cover all11 current targets. Ten behavioral files and writer copies match after-all-6efd7e25-a4a7-45c1-bac5-2d1ff33e72e4. .gitignore differs intentionally and matches later hygiene final744e5fab...; old copy still matches old manifest. Original service/unit/PGspec/probe byte-identical to T2B.
src/modules/client-followup-tasks/client-followup-tasks.service.ts SHA256 a3522bb55c67f372b8dccbae9f8ac26ec875e331e01619933110a28284cd1d67
src/modules/client-followup-tasks/client-followup-tasks.service.spec.ts SHA256 8a8c05f822e948c51e240ba7e8735a4069175c03457df8da2bd695248437a8e7
scripts/probe-client-deletion-lock-order.cjs SHA256 8b5ba61a1cf147c643727dbfb2f7139126e6f08647906bb7cf5ad9004ddc8ac4
scripts/run-followup-tasks-integration.cjs SHA256 289963ff8c42f825b3cc8c86e38fdb9968487d5917fcc9fbd95f32756d8a25a9
src/modules/client-followup-tasks/client-followup-tasks.pg.spec.ts SHA256 9cd76e4e88c853bd8fa679e6307f30e1378e075ef22eed4ce8778656807f8dd5
.gitignore SHA256 744e5fabdf9b6ab18ba98cd0d4d83b7ae15548b8d06c88faa4f5af2f7f6e62a2
src/app.module.ts SHA256 10776922367082f63a33348839d042d67779f875bc8e680c942a3e90cc0138a0
src/modules/client-followup-tasks/client-followup-tasks.controller.ts SHA256 56b888178c7278a7550c466d0c9837dd0d36c9836ce13453c72f626d1a133179
src/modules/client-followup-tasks/client-followup-tasks.module.ts SHA256 dba8ebdf1f477df2f0be42e7eaf07ea9a8f5cedb4cbe523879a9abd57d8980c4
src/modules/client-followup-tasks/client-followup-tasks.http.spec.ts SHA256 7dbf676e4001c31cdea000a2e4fe9d8c7f07d7cf64bbd57449d95e3f6e8c784b
src/modules/client-followup-tasks/dto/client-followup-task.dto.ts SHA256 8deceeafa82173e4dcf2f692f76b8f810fe50637cf8df9e18da71bf9150bcdbf

## Independent audit
CodeGraph root/index/query checked first; current controller query had no results, so exact scoped source reads used. Actual AppModule imports actual module/controller/service/PrismaModule; global FirebaseAuthGuard then RolesGuard and controller-level ADMIN/SUPER_ADMIN metadata are production wiring, not test-only. POST base/GET and PUT :taskId follow adherence route convention at /api/v1/admin/clients/:clientId/follow-up-tasks.
Identity seam replaces only token verification with controlled UID acceptance/rejection, not guard or actor/role injection. Real bearer parser, persisted database user/eligibility, RolesGuard and scoped service run; missing/invalid401, CLIENT/unassignedADMIN403 tested. Token cryptography/live Firebase/session transport not claimed.
DTO RawInput prevents implicit numeric/string conversion; create fields override inherited optional validation (missing400). Only description permits null. Service handles normalized lengths, calendar/year-zero and eligible assignee. Pre-pipe own-key rejection catches __proto__/constructor/prototype before transform stripping; rawJSON tests retain malicious keys. Forged owner/creator/version/timestamps/create-status unknown400. Parent route/auth supplies owner/creator; owner mismatch404, normalized replay201/conflicts409, stale/closed409, timestamps and retained closed rows checked. No new plan/message writers.
Test imports module selected from AppModule metadata but reconstructs guards; actual production providers independently inspected. Validation prefix/options/filter match configureApp. Test TransformInterceptor lacks UploadsService, but task output has no signing keys. Omitted ApprovalInterceptor is pass-through for routes lacking RequiresApproval metadata. Full AppModule/bootstrap/schedulers/OpenAPI/live Firebase not independently smoke-tested.
No deterministic application defect found. Broader FU-01/02/03/05 remain: complete production-writer races, bulk deadlocks, comprehensive operation-specific graphs and populated history/message fixtures. HTTP explicit winner classification covers tested FU-04 scenario only.

## Preservation/visibility limits
T2B6760 physical files; baseline6722 evidence hashes+37 final artifact hashes all match (t2b-filelevel-preservation.json). Hygiene aggregate f8c56... not reproduced by documented algorithm: actual639e76... in t2b-preservation.json. No individual content drift/deletion found; nonblocking documentary gap requires algorithm/order clarification in a new receipt, not historical rewrite.
Ignored run/checkpoint recovery is LOCAL ONLY. /build/ rule does not cover authorized build-independent:846 new visible generated entries. Did not change ignore/delete output. Safe verification artifacts retained under approved root.

## Retained resources
http-b795ce3c-e17e-4ce8-ba7f-f871a4c7e111: exom-rest-t2c-2a63eed6-a946-4492-b01d-ca496dff2697 ID 268ba9fdf518c1f8d3d1fb406f7768abb0f3680e4d86e8485f76270a2bcd3b6b loopback53549; resource.json/migrations.json/retained-databases.json.
pg-b3fb7ee7-5545-4d1b-9b7c-a3c0e6c8c522: exom-rest-t2c-6560c312-e8b5-48a7-a0dd-3fe5b716b750 ID 515ea02e74acbf772d0ad9050de9a5d3124de737f6a4efde6746706a5c502cbf loopback53768; resource.json/migrations.json/retained-databases.json.
all-3e6bff5e-8ffb-4cad-8f06-978e42b852d7: exom-rest-t2c-30f38a47-31bf-49ca-94c7-4c25925216e4 ID 5bbffa36121d78f2ce061551bdb9798d9ce6f3aa9b5fc73562654cf8da8ab4ab loopback53777; resource.json/migrations.json/retained-databases.json.
Database/role exom_ci; PGDATA /var/lib/postgresql/exom-ci-data. ALL retains12 databases. No resource stop/delete/cleanup.

API feat/progreso-adherencia-p4 / origin/feat/progreso-adherencia-p4 HEAD c383d47f4aa8217f727acf33e4c1900c0866b7bd. Existing tracked edits only .gitignore/AppModule; final-status.txt includes expected generated noise. Native review and parent scoped closure pending; no next-unit authorization exercised. Memory tools unavailable; these receipts are handoff.
