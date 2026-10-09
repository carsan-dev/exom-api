# REST-T3B — versioned recap drafts and explicit publication

> Copia saneada para entrega: ubicaciones normalizadas; resultados, fechas y hashes conservan su significado histórico y corresponden al snapshot privado original, no a esta copia. WORKSPACE_ROOT identifica la coordinación; SDK_ROOT el SDK instalado; RUNTIME_ROOT las herramientas locales; TEST_ARTIFACT_ROOT los recursos privados retenidos, no publicados.


## Current disposition — independently verified, APPROVED, local commit pending

2026-10-05. Parent reports independent unit **25 PASS**, full **110 suites / 1374 tests PASS**, including **37 publication cases**, and generate/validate/nondeleting tsc/lint PASS (0 errors / 2 existing warnings). Independent receipts under the retained T3A root: `run-unit-6b94909e-4bee-4cfe-aaec-2ed4c4a1e69f`, `run-all-f19fc980-204b-476e-a0a2-de9499f48bba`, `run-checks-2d01594d-54b2-4ce1-b4db-53232ba71502`.

Parent-reported native `review-eb6516983f1e5a01` **APPROVED without advisories**, exact ACK consumed for revision `e3ad3c7b33c76c9c842c3dc8104d2adbe6ea161b9184b9c45cb29c6fb752fae0`, target `sha256:96e8a8c1b64aa543c2940c912cff127a014c86cda80741b2a8cd978ccf739bc0`, tree `899165ffa65e3368acfe5e34f1f1f3e15ad058e3`. Six source hashes below remain unchanged. Parent owns the pending local commit; this documentation worker invokes no review or Git mutation.

User explicitly requested stopping after T3B tonight. **No T3C work starts now; REST-T3C is the next unit tomorrow.** No UI/App/print, deployment or whole-P5 closure is claimed. The earlier writer-only chronology and all failures below remain historical evidence; synthetic identity and equivalent legacy-SQL limits still apply.

## Identity and contracts

API root `${WORKSPACE_ROOT}/exom-api`, branch/upstream `feat/progreso-adherencia-p4` / `origin/feat/progreso-adherencia-p4`, unchanged base HEAD `f709b2e3894bfbb656ada5ab8400a035a8dc7a98`. Initial tree contained only original deletion probe; its unchanged SHA256 is `8b5ba61a1cf147c643727dbfb2f7139126e6f08647906bb7cf5ad9004ddc8ac4`. Read current root task's REST-T3B IN_PROGRESS intent and retained T3A/privacy decisions before writes. Index untouched. Schema/migration/runner/ignore bytes match committed HEAD.

- Admin-only `PUT /recaps/:id/review-draft`: mandatory raw integer `expected_version` (0–2147483646); optional nullable strings `coach_summary`, `changes`, `next_week_goals`, each at most 3000 characters. Omission preserves, explicit null or trimmed blank clears, nonblank text is trimmed. No provided review field means 400. A valid supplied field increments version even if its normalized value matches storage.
- Admin-only `POST /recaps/:id/review-publish`: mandatory expected_version and literal boolean `confirm:true`; no review text is accepted. Copies all three persisted draft fields under the same locked CAS and increments version once. Explicitly confirming cleared fields is permitted. No automatic merge, inferred historical publication or notification.
- Both reject DRAFT, missing submitted_at and archived recaps with 403, stale versions with 409, missing recaps with 404, invalid/unknown/coerced command inputs with 400. Lost-response repeat publication with the old version returns 409 without another write/effect.
- First publication of a currently SUBMITTED recap atomically sets REVIEWED and reviewed_at. Already REVIEWED recaps retain reviewed_at exactly, including legacy nulls. Legacy submitted/feedback sent/read timestamps and internal notes are never copied back or overwritten by these commands. updated_at remains Prisma-managed.
- Authorized command responses contain id/status/reviewed_at, fresh review_version and six draft/published fields. Existing staff detail remains the reread surface. Client mutation/list/detail share the canonical projection: the previous 39 safe legacy scalars plus **published_coach_summary/published_changes/published_next_week_goals only**. Drafts, version and internal notes remain absent. Read-feedback still returns success only. The client keeps its last publication while a new draft is edited.

## Reader/writer and lock audit

CodeGraph query preceded scoped filesystem exploration. `recaps.service.ts:34` owns the canonical client projection; mutation writers/selects `:271–423`, client list/detail `:442/:453`, legacy staff review `:715+`, admin detail and archive remain existing surfaces. Legacy review continues to affect only its notes/feedback/status timestamps and notifications; it does not increment the new review_version. New writeReview (`:653`) uses an explicit update set, so concurrent legacy metadata cannot be accidentally copied from a stale row image.

New reviewTransaction (`:564`) reuses the follow-up task/deletion protocol, without changing other authorization writers: shared diet-history barrier → per-client day-progress advisory lock → sorted User FOR SHARE locks → active ADMIN assignment FOR UPDATE → recap FOR UPDATE. This matches `client-followup-tasks.service.ts:117–195` and `client-deletion.service.ts:80–85`; SHARE (not KEY SHARE) blocks eligibility changes through commit. It rereads persisted role/all four eligibility flags, client role/writability/deletion intent, assignment and recap after locks. Eligible SUPER_ADMIN keeps global access; stale role claims, inactive/locked/archived/identity-pending staff and unassigned ADMIN cannot write. ReadCommitted, common maxWait 5s/timeout 30s, guarded id+review_version UPDATE and locked fresh response read.

Causal legacy exception: submit previously performed DRAFT lookup then an unguarded status UPDATE. A delayed submit could downgrade a later publication to SUBMITTED. Its UPDATE now additionally requires the owner and actual DRAFT state; P2025 maps to the existing 403. No shared review-version bump or unrelated legacy-review rewrite. The HTTP/PG regression resumes a captured actual old DRAFT lookup after successful submit/publication, while the real PostgreSQL write guard rejects it and preserves status/version/timestamps. This lookup is explicitly simulated, not claimed as a full async-network interleaving. Existing-row client-answer create/update precheck gaps are not refactored here; those updates do not write publication/version/status fields (new recap insertion still initializes DRAFT normally).

Privacy tests deliberately adapt from 39 safe legacy fields to **39 + 3 additive published fields**, retaining exact equality and all private-field exclusions. Existing client DTO rejection tests still reject all published/draft/version inputs. Existing admin notes and legacy feedback tests remain intact. No App/Admin consumer edits; old clients can ignore additive response fields.

## Observed TDD and validation chronology

Unchanged runner writes only newly authorized unique run directories under `../rest-t3a-20261005/`. All logs, Jest reports and child command receipts are retained. No historical receipt or run was edited.

| Exact command | Run | Observed result |
| --- | --- | --- |
| `node scripts/run-recap-review-persistence.cjs all` | `run-all-61224241-fc9b-410e-975f-60bc59aa1769` | RED: 35 missing-route failures (404 instead of expected behavior), 1337 PASS; 109 passed / 1 failed suites, zero skipped. |
| `node scripts/run-recap-review-persistence.cjs unit` | `run-unit-19c09d01-f9c9-46a2-a251-5d04c9b66baf` | GREEN: 25 PASS / zero pending. |
| `node scripts/run-recap-review-persistence.cjs all` | `run-all-a0dd8656-abbd-432b-a8bf-bbf6516fcb89` | GREEN: 110 suites / 1372 tests, zero skipped/pending. |
| `node scripts/run-recap-review-persistence.cjs checks` | `run-checks-ae08004e-ef98-483a-af0d-3b468621ebbc` | FAIL: 50 authored formatting errors; generate/validate/tsc PASS; 2 existing progress-concurrency warnings. No autofix; targeted formatting edits. One overlapping exact-replacement edit was rejected atomically before writes and corrected with disjoint replacements. |
| `node scripts/run-recap-review-persistence.cjs checks` | `run-checks-55a0733a-5132-437b-b1e2-865075ea2b50` | PASS after formatting and added triangulations. |
| `node scripts/run-recap-review-persistence.cjs unit` | `run-unit-673b999d-9fd9-4ee9-870a-4cd7904b7707` | Final service PASS: 25 tests / zero pending. |
| `node scripts/run-recap-review-persistence.cjs all` | `run-all-a01a17e2-e686-44ca-8acf-fbcadf380399` | FAIL retained: 1373 PASS / 1 FAIL, zero skipped; added raw-SQL legacy timestamp fixture shifted by host timezone. Exact timestamp assertion was preserved; fixture input changed from JS Date to explicit UTC ISO string for timestamp-without-timezone. |
| `node scripts/run-recap-review-persistence.cjs all` | `run-all-65b18ec2-49b3-4121-9f2f-f964624d3df2` | Final PASS: **110 suites / 1374 tests, zero failed/skipped/pending**; dedicated new suite **37/37 PASS**. |
| `node scripts/run-recap-review-persistence.cjs checks` | `run-checks-9521e698-4c57-4abb-b169-c1c708ae6fdc` | Final PASS: Prisma generate/validate, isolated nondeleting tsc, lint without fixes (0 errors / 2 unchanged warnings), diff check. |

37 new HTTP/PG cases cover DTO types/unknown fields/version/confirmation/bounds, partial/null/blank semantics, stale commands/replay, required submission and archive state, persisted eligibility/assignment/global SUPER_ADMIN, canonical client privacy and legacy retention. Real Nest routing/ValidationPipe/RolesGuard/service/Prisma/PG with synthetic identity middleware; no live Firebase/JWT/full-bootstrap claim.

### Coordinated concurrency evidence

- Save/save and save/publish: a dedicated transaction holds the recap row; the first HTTP save is observed waiting on a real row-lock edge in pg_stat_activity/pg_blocking_pids; the opponent is observed waiting on the per-client advisory edge. Only then is the holder committed. First returns 200, second 409; version increments once, old published content remains intact and loser fields do not merge. Subsequent explicit publication copies the winner's persisted draft.
- Assignment and staff revocation: dedicated transactions update the relevant scope row but do not commit; the command's real assignment/user lock wait is observed, then revocation is committed. Command returns 403 without incrementing version.
- Legacy-column interleaving: a raw SQL transaction representing the existing legacy note/feedback/status writer holds the recap row; publication's actual blocking edge is observed. After commit, new publication retains the concurrent notes/feedback/reviewed_at exactly while publishing only draft fields. This is an explicit SQL equivalent-writer simulation, not a claim that the legacy HTTP notification path was forced into that interleaving.

Polling is used only to observe actual PostgreSQL blocking relationships with a bounded failure deadline, never as a sleep-only concurrency guarantee. No external notifications from the new paths; no resources are stopped or cleaned up.

## Isolation, exact hashes and handoff

Final full-suite owned resource: `exom-rest-t3a-da63a9d2-13e6-4ce2-9b00-ef06065dd7e6`, container ID `c9893097554bc51e1a8285ceaab78a09281ca15994fbbef874b3cef094e2e167`, `127.0.0.1:55571`; role/database `exom_ci`, legacy84 template `exom_ci_history_legacy_7f814563`, PGDATA `/var/lib/postgresql/exom-ci-data`. Runner verifies full ID/name/ownership labels, running state, loopback binding/tmpfs-only mounts and SQL database/role/data-directory identity before writes and afterward. Explicit sanitized aliases, test-only SSL disable and tracking OFF; 92 current migrations, no schema change. All four new all-run containers, fixtures and suite clones remain retained. No production dotenv/fallback, installer/dependency change, remote mutation, resource deletion/reset/truncate/SQL REVOKE/shutdown or destructive migration rollback; fixture-level eligibility/assignment revocations are the explicitly authorized tests above.

| Source | Final SHA256 |
| --- | --- |
| `dto/review-publication.dto.ts` | `3f10a55af097dbf9bf93d39df5c9b6497161381dd2c921311ff55e573b82fbfb` |
| `recaps.controller.ts` | `607a43a5c04002a0114fd1066e1d2bb335c413de9e18f9d41cb832264a3563d0` |
| `recaps.service.ts` | `edc19b769620516e149228e39aefb276cb4780a9bf4ea324e3a9f265c8b0bc22` |
| `recaps.service.spec.ts` | `e3a562587487203f44190806ba9fe7bbe4d3d2f3a14386f9d30139725576b4a6` |
| `recaps.controller.spec.ts` | `306a9452353b9cf9e9bc7fec802848302a7b4e74a14423bbaf4babafafe038b8` |
| `recap-review-publication.spec.ts` | `c361959fd879590d2263216ffb08e168eeb1ea03c5513ced336e60fce4928b40` |

All source paths above are under `src/modules/recaps/`. Tracked patch SHA256 `47066a961c1423274c9837a6b1b65f851e5417ac1138755af9dddb505b81b0e7` (247 additions / 14 deletions); new DTO and dedicated spec are untracked authored files, not included in that tracked patch. Existing runner manifests cover service/spec but omit controller/new DTO/new spec; those additional exact hashes are recorded here without altering the runner. Source snapshots for runner-covered paths remain `.snapshot`; run artifacts are ignored LOCAL ONLY. Current approved checkpoint: [manifest](../rest-t3a-20261005/checkpoint/t3b-approved/manifest.json), full tracked patch, six exact source snapshots plus this receipt, branch/base/index/status and unchanged original-probe hash. Generated resources, secrets and recursive copies are excluded. Archive the ignored checkpoint separately for portable recovery. Independent verification/native approval/ACK are now complete; only the parent-owned local commit remains for this unit. No claim of whole P5/P6 or UI/App/print integration; REST-T3C waits until tomorrow.
