# REST-T2B — internal manual-task service evidence

> Copia saneada para entrega: ubicaciones normalizadas; resultados, fechas y hashes conservan su significado histórico y corresponden al snapshot privado original, no a esta copia. WORKSPACE_ROOT identifica la coordinación; SDK_ROOT el SDK instalado; RUNTIME_ROOT las herramientas locales; TEST_ARTIFACT_ROOT los recursos privados retenidos, no publicados.


Date: 2026-10-05. **Corrected bounded REST-T2B independent verification PASS; native approval ACK completed.** Parent owns coordination closure. No whole-P5/P6 completion, HTTP/module wiring, UI, projections, commits, publishing, remote data changes or resource deletion.

**Current consolidated receipt:** [final-scoped-receipt.md](final-scoped-receipt.md). It records exact latest receipts, prior Prisma PASS evidence, consumed native lineage, verified snapshots and explicitly owned OPEN follow-ups. Sections below retain the implementation/correction history; their earlier receipts are not the latest independent repeat.

## Result

The pre-existing internal service and its 44 unit tests passed. No deterministic service defect was demonstrated, so both files were preserved byte-for-byte rather than manufacturing a behavioral change. Added 12 real PostgreSQL service tests and an isolated retained-resource harness. The corrected final full Jest run passes all 106 suites / 1228 tests with zero pending tests. The authorized nondeleting TypeScript build also passes after correcting a candidate-caused checkpoint format defect; see the correction below. Prior independent Prisma generation/validation are PASS with unchanged schema/config; the corrected independent nondeleting TypeScript build is PASS and native review ACK is completed. These are no longer pending; see the final scoped receipt. Nest build was not executed.

Strict test-first intent applies to any behavior correction. **Service RED/GREEN exception:** this delivery adds validation without changing service behavior. Initial harness failures are not claimed as service RED evidence. No tests or assertions were weakened or disabled to obtain green.

## Latest independent receipts and native result

[Corrected independent verification](independent-verification/corrected-candidate.md) records fresh PASS: unit 44/44 (`unit-acf0bd37-54e6-4abe-bee1-f73373079491/`), servicePG 12/12 (`pg-9e745ee4-9f53-48ff-940c-96ba4744e111/`), full Jest 106 suites/1228 tests (`all-db49d3c4-8575-4a05-83ca-1b43605ee1f4/`), lint zero errors/two unchanged warnings, and the nondeleting `final-independent-build` tsc command. Exact commands/log paths are consolidated in [final scoped receipt](final-scoped-receipt.md#exact-verification-commands-and-receipts).

Prior `npm run prisma:generate` and `npm exec -- prisma validate` PASS are recorded in `independent-verification/prisma-generate.log`, `prisma-validate.log` and the [prior report](independent-verification/README.md). The correction did not change schema/config; no repeat was requested. That report's build blocker is superseded by corrected-candidate.md, not its valid Prisma evidence.

[Corrected hash audit](independent-verification/corrected-hash-audit.json): 888 rename-inventory entries, 77 checkpoint entries, all 906 snapshots covered, zero failures/uncovered files. Fresh declarations in `final-independent-build/` are expected compiler outputs, distinct from checkpoint copies.

Parent-provided native lineage `review-b8a48996024e9dec` completed exact approval ACK: closed / native-approved-acknowledgement-completed / authority burned. Target, tree, four selected paths and consumed revision are recorded in the final receipt. Initial unassessable/blocked attempts remain history; intended-untracked selection resolved them, with no lifecycle rerun in documentation finalization.

Only native advisory `R3-snapshot-collision` (WARNING, harness:35-39) is explicitly nonblocking/no correction. It remains OPEN for later harness hardening with concrete acceptance. No unspecified finding details are inferred. Verifier coverage limits likewise have IDs, owners and acceptance in [bounded follow-ups](final-scoped-receipt.md#bounded-follow-ups--open-explicitly-owned): complete production writer transactions, multi-row bulk deadlock tests, operation-specific retained lock graphs, explicit fulfilled-winner classification and populated protected history. They are not newly proven service defects or broad guarantees already validated.

## Historical writer verification receipts

| Exact foreground command | Observed result | Receipt relative to this directory |
| --- | --- | --- |
| `node scripts/run-followup-tasks-integration.cjs unit` | Initial FAIL: Windows NODE_OPTIONS backslash quoting broke preload resolution; fixed harness path quoting before re-run. | `unit-ff28266b-4bbc-4ad1-b7ec-17e54917b98b/jest.log` |
| `node scripts/run-followup-tasks-integration.cjs unit` | PASS 44/44, zero pending; repeated final source validation. | `unit-b0411b22-e2ec-44dc-ad83-aa4c0e7ae52f/jest.log`, `jest.json` |
| `node scripts/run-followup-tasks-integration.cjs pg` | Initial PASS 10/10; expanded final service suite PASS 12/12, zero pending. | `pg-ae92a726-af67-4ea0-af78-955d42255252/jest.log`, `jest.json`, `resource.json` |
| `node scripts/run-followup-tasks-integration.cjs all` | Initial FAIL: 105 suites/1219 tests passed, nine history-baseline cases failed because their owned legacy84 launcher prerequisites were not prepared. No baseline exception claimed. | `all-141d44cf-ab5e-4f72-9913-9389d0b43d2b/jest.log`, `jest.json` |
| `node scripts/run-followup-tasks-integration.cjs all` | PASS after harness prepared legacy84 template and timestamp-off environment. Repeated on final harness: 106 suites / 1228 tests, zero pending. | `all-79b515c7-25dd-4272-a8e2-ad7b95a0b2dd/jest.log`, `jest.json`, `migrations.json`, `resource.json`, `retained-databases.json` |
| `npm run lint -- --no-fix` | Initial FAIL: formatting errors and two lint errors in the new test. Corrected manually, with no auto-fix. Final PASS: zero errors, two warnings in unchanged progress.concurrency.spec.ts lines 474/482. | `lint-final.log` (recorded terminal output) |
| `git diff --check` | PASS for tracked diff. New files are untracked, so this is not a whitespace check of their content; final ESLint covers the new TypeScript test. | Final working-tree observation below. |

The table above preserves the initial delivery receipts. Its final harness change added retained-database inventory. The subsequent corrected candidate and its final receipts are recorded below; prior failures and intermediate logs remain intact.

## Independent-verifier correction — 2026-10-05

**Cause and bounded scope:** raw checkpoint `.service.ts` copies under evidence were picked up by tsconfig.build.json's broad inputs, but their relative imports could not resolve from their copied locations. This was candidate-caused, not an environmental exception. Before correction, the explicitly authorized nondeleting tsc command reproduced 33 TS2307 errors. The fix changes artifact format, not compiler exclusions, service behavior or acceptance criteria.

Existing evidence `.ts` files—including compiler-emitted `.d.ts` artifacts—were renamed to `.ts.snapshot` without deletion or overwrite. SHA256 was checked before/after every rename. Original source-key hashes remain in checkpoint manifests; new `snapshot_paths` entries point to preserved files. Future harness checkpoints directly use the safe suffix. Two inventories record every preserved path/hash: `snapshot-renames-f1157069-3202-403b-8658-b6360ae44e1a.json` (609 renames) and `snapshot-renames-e8cdf93b-a4b7-4d2f-a05b-eb6983a394b3.json` (279 renames). These totals include generated declaration artifacts, not 888 authored source changes. At the writer's correction checkpoint, scoped discovery found no `**/*.ts` files under this evidence directory. The later independent build's fresh declarations are expected output, as the corrected verifier distinguishes; this historical observation is not a claim that the final build emitted no declarations.

**Test corrections, without weakening:** the reverse authorization race now writes `role='CLIENT'`, not is_active, proves the writer blocks until the authorized update commits, then checks stale ADMIN access is rejected. Ineligible SUPER_ADMIN assignee checks now use a separate active assigned ADMIN actor, so rejection cannot be caused by invalidating the actor itself. The original service/spec and deletion probe remain byte-identical.

| Exact corrected command | Observed result | Receipt |
| --- | --- | --- |
| `node scripts/run-followup-tasks-integration.cjs unit` | PASS 44/44, no pending | `unit-9136ae41-71ec-44ce-aa20-bc5c340d7143/jest.log`, `jest.json` |
| `node scripts/run-followup-tasks-integration.cjs pg` | PASS 12/12, no pending | `pg-2ecfe026-ca6e-4083-8b5a-82e81c1e69f9/jest.log`, `jest.json` |
| `node scripts/run-followup-tasks-integration.cjs all` | PASS 106 suites / 1228 tests, no pending | `all-de6807b9-9ce6-4d22-bcc1-b7fefb39fe63/jest.log`, `jest.json` |
| `npm run lint -- --no-fix` | PASS, zero errors; same two unchanged-file warnings | `correction-validation.log` |
| `npm exec -- tsc --project tsconfig.build.json --outDir docs/evidence/rest-t2b-20261005/corrected-build --incremental false` | Observed RED: exit 2 / 33 TS2307; GREEN: exit 0 / no diagnostics | `correction-validation.log`; output artifacts retained in `corrected-build/` |

RED/GREEN here is evidence for the deterministic checkpoint/build defect, not a claim of a service behavior fix. No compiler config expansion, exclusions, deletion, test skipping or weakened assertions. All emitted build output stayed in the authorized evidence directory; the full harness subsequently preserved emitted declaration files with noncompilable suffixes. No source/harness changes followed the corrected final full-suite run.

Incremental authored diff from the prior final candidate checkpoint: PG test **+10/-3**, harness **+41/-2**, service/original spec/probe **0 changed bytes**. Evidence-only renames and manifest/document updates are separate from those source counts.

## Service coverage

- Assigned active ADMIN and active SUPER_ADMIN access; CLIENT and unassigned ADMIN denial; cross-client GET/UPDATE isolation.
- Revalidation of active/locked/archived/identity-pending staff flags; explicit client/unassigned/ineligible staff assignee denial.
- Forced PostgreSQL interleavings: actor deactivation, role change, assignee deactivation, client deactivation and assignment revocation start first; `pg_blocking_pids` proves the service actually waits. Committing the revocation yields ForbiddenException and an unchanged version/title.
- Reverse race: hold the task row after authorization has acquired its locks, start a role writer, observe the writer blocked, then release the task and verify the authorized service update commits before the role write completes.
- Two same-version contenders held behind the client advisory barrier: observed waits, exactly one conflict and persisted version 2. Explicit fulfilled-winner outcome classification remains REST-T2B-FU-04; this receipt does not claim that assertion already exists.
- Two same-payload creates held behind the client barrier: observed waits, one persisted row and equal results. Different payload/creator/owner collisions conflict without exposing another owner's task.
- Completed/cancelled task timestamps and closed-field immutability; fixture snapshots of all non-task tables are unchanged. Body metric is populated, but most history/plan/message/outbox tables are empty: broad populated-history retention remains REST-T2B-FU-05.
- Archive retains the closed task for authorized historical reads while refusing new writes. Overflow conflicts and a null historical assignee is preserved on unrelated edits.
- Existing unit suite additionally checks deletion-in-progress/owner flags, malformed input, normalization, stale retries, legacy assignees and sorted lock order. These mocks supplement—not substitute for—the PostgreSQL tests.

## Authorization writers / lock ordering inspected

CodeGraph exploration preceded scoped source inspection. Relevant current writers include UsersService.updateRole (User UPDATE then assignment bulk deactivation), UsersService.setClientArchived (sorted User UPDATE then assignment SHARE), UsersService.syncClientAssignments (assignment updateMany/createMany), and ClientDeletionService request (catalog/client advisory barriers then sorted User UPDATE). Task service scope uses catalog/client advisory barriers, sorted User SHARE, sorted relevant active assignment UPDATE, then owned task UPDATE. SHARE protects non-key role/eligibility changes; assignment UPDATE protects direct/bulk revocation. PostgreSQL tests exercise raw conflicting row writes in both orderings, not complete production writer transactions. Multi-row bulk deadlock freedom and operation-specific retained lock graphs are not proved; follow-ups REST-T2B-FU-01–03 own those checks. No writer outside the allowed surfaces was edited.

## Isolation and retained resources

The harness creates a fresh labelled container with a random name/credential and dynamic loopback port. Before schema/fixture writes, it verifies full container ID/name/label, running state, exact port, PGDATA, tmpfs-only mounts/no binds, and actual SQL database/role/data_directory. Fresh public schema must be empty before migration application. All 91 migrations are applied as SQL only inside this identified owned cluster; legacy84 prerequisites and test-created clones are in that same cluster. No repository dotenv contents or inherited service credentials are used; a test preload returns empty contents for repository dotenv reads, including tests that temporarily set NODE_ENV=production. No production URL fallback.

At their receipts, owned containers were retained; no stop/remove/drop-cluster action occurred. This documentation pass performs no fresh live-resource inspection. New T2B tests retain fixtures. Existing full-suite tests perform their normal synthetic fixture operations inside the owned cluster; no existing or remote resource is adopted. Runtime PostgreSQL connections are disconnected after use. Disposable credentials are not persisted in receipts.

| Receipt | Retained owned container name | Full ID | Port |
| --- | --- | --- | --- |
| First PG | exom-rest-t2b-c45e0146-6ddd-4ebd-8a90-8cfdd616a863 | 72464d1a9eba27bf92cda4d522f0868f8e45993d817e4a6718d0a06ec8c993db | 52875 |
| Expanded PG | exom-rest-t2b-1100c831-a096-442e-ad54-1efde69aab6f | 0c461110bf1b39bc566046e61bbb7ab1ba2733f94d1cedc331bacae07e5a0a37 | 57740 |
| First full / failed prerequisites | exom-rest-t2b-ef0425bc-9bbc-4d0d-a351-b8401f7827ce | 66fe83c3950c92e435872ba4b4fe6486505545ccc16f65adfdb606632381cf62 | 57754 |
| Full / prerequisites corrected | exom-rest-t2b-1a5cd7a2-dcb3-499b-83fd-ad883446d8a1 | 03faf1932cfa7bfaf95c9bbeb2acfebbfbf7844790005e248d90e0c08653b190 | 50602 |
| Previous full | exom-rest-t2b-6b26c3ea-5568-49d4-b552-252d188a24b8 | f1d47d1e6cf557c94fa117848824fa304dbe0d2f03607c5d046a8f06c1d882d6 | 64956 |
| Corrected PG | exom-rest-t2b-87e01cb7-d73d-4217-b588-2c58ec1e1d1d | de5087316b685a3d82222fa280407bf9915a8aae9896bf16187b229449452629 | 63224 |
| Corrected final full | exom-rest-t2b-9a1a7a54-3219-4c02-b990-ab5f2c4c0cf7 | 40fd92e89d5b469a8f1be14d827144a98535ae03805f169c953c041a8c6bb471 | 63261 |

Each uses role/database `exom_ci`, data directory `/var/lib/postgresql/exom-ci-data`. Final full `retained-databases.json` inventories exom_ci, its legacy84 template, nine owned history clones and postgres. Existing full-suite baseline tests retain these clones. No future cleanup is authorized by this receipt.

## Recoverable checkpoints / working tree

API root: `${WORKSPACE_ROOT}/exom-api`; coordination root is non-Git. Branch preserved: `feat/progreso-adherencia-p4`, upstream `origin/feat/progreso-adherencia-p4`, HEAD `c383d47f4aa8217f727acf33e4c1900c0866b7bd`. Registered feat/integridad-subidas is an ancestor; merge-base `c0083e898bdffa965b6949c80eb4a189cb334372`.

- `before/manifest.json` and safe copies capture the original service/spec/deletion probe and coordination-document hashes before source changes.
- Prior `after-all-7a6a796e-b971-405a-b16a-81947c9713a4/manifest.json` retains its source hashes and now maps its preserved `.ts.snapshot` paths.
- Corrected final `after-all-f95da048-9666-4283-8e0d-ed2e4446a3c4/manifest.json` and safe copies include every authored source/harness target plus the original files. These copies, not HEAD alone, recover the untracked implementation. Follow `snapshot_paths` for the actual noncompilable copy locations.
- Original service SHA256 `a3522bb55c67f372b8dccbae9f8ac26ec875e331e01619933110a28284cd1d67` unchanged.
- Original spec SHA256 `8a8c05f822e948c51e240ba7e8735a4069175c03457df8da2bd695248437a8e7` unchanged.
- Original deletion probe SHA256 `8b5ba61a1cf147c643727dbfb2f7139126e6f08647906bb7cf5ad9004ddc8ac4` unchanged.
- Prior PG test SHA256 `66ab316b0a8caf40e7d4fa55041d131205a3fee7b64221fb739baca906f68014`; corrected final `9cd76e4e88c853bd8fa679e6307f30e1378e075ef22eed4ce8778656807f8dd5`.
- Prior harness SHA256 `66d8360b8faef6a671c7736bf407dd4a273ed9ae949875232be6317f9506d71f`; corrected final `fe5268ca50fb78a22fb3fd918bdf3551013241aa871e15fd3d30f49a954f251c`.

Only new untracked harness/test/evidence were authored. No tracked edits, staging, commits or branch changes. Parent retains coordination ownership. Independent corrected verification, prior Prisma generation/validate and nondeleting TypeScript build are PASS; native approval ACK is completed. Parent owns coordination disposition and separate final-document capture. The [final scoped receipt](final-scoped-receipt.md) is the current consolidated record. HTTP/module integration is only the next proposed unit—not started; shared projections/Admin, REST-T3 and P6 remain outside this delivery. No whole-P5 closure is claimed.
