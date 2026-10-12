# REST-T2E1 — paginated internal tasks and eligible assignees

> Copia saneada para entrega: ubicaciones normalizadas; resultados, fechas y hashes conservan su significado histórico y corresponden al snapshot privado original, no a esta copia. WORKSPACE_ROOT identifica la coordinación; SDK_ROOT el SDK instalado; RUNTIME_ROOT las herramientas locales; TEST_ARTIFACT_ROOT los recursos privados retenidos, no publicados.


Implemented and locally validated on API base `f28e4f650b8c9328e3da3087a17770782b252634`, branch/upstream `feat/progreso-adherencia-p4` / `origin/feat/progreso-adherencia-p4`. Independent review and parent-owned Spanish local commit remain separate. No Admin/App changes, recap lifecycle, P6, schema changes, publishing or deployment.

## API contract for Admin

Base: `/api/v1/admin/clients/:clientId/follow-up-tasks`.

| GET | Query | Behavior |
| --- | --- | --- |
| Base | `page`, `limit`, `view`, `status`, `assigned_to_id` | Internal task page, never implicit assignee-only filtering. |
| `/assignees` | `page`, `limit` only | Eligible task assignees for the selected client; not assignment-management authorization. |
| `/summary` | Unchanged | Single canonical next-task/review source. Neither list nor frontend should recompute it. |

Page defaults: `page=1`, `limit=20`; integer bounds: page 1–1,000,000, limit 1–100. Unknown keys, repeated query values, prototype fields, invalid enum/UUID and out-of-range values return 400. No client/creator/sort override.

- No view/status: active (`PENDING`, `IN_PROGRESS`).
- `view=history`: `COMPLETED`, `CANCELLED`; `view=all`: all four states.
- `status=<one of the four enum values>` alone selects that status across all states, including history. Explicit view plus status intersects; incompatible combinations return an empty page.
- `assigned_to_id=<UUID>` filters current/historical responsibility. `assigned_to_id=unassigned` selects null/removed assignees. Omission selects everyone. Unknown valid UUID returns empty. Literal `null` is not supported.
- Order: civil due date ascending; explicit HIGH/MEDIUM/LOW; creation ascending; id ascending. Shared ordering preserves the canonical summary selection semantics.
- Assignees order: display name ascending, nulls last, id ascending.

Both endpoints retain the existing transport envelope (`data` below contains the page):

```ts
interface Page<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}
interface AssigneeDisplay {
  id: string;
  display_name: string | null;
}
// GET base: Page<ListedTask>; GET /assignees: Page<AssigneeDisplay>.
// ListedTask is exported from client-followup-tasks.queries.ts:
// id, title, description, type, due_date, priority, status, version,
// created_at, updated_at, completed_at, cancelled_at,
// assigned_to_id, assignee: AssigneeDisplay | null.
```

`due_date` is YYYY-MM-DD; timestamp fields are ISO-formatted PostgreSQL JSON strings (nullable completion/cancellation). Only profile first/last name supplies display names; absent/blank profile gives null, never email fallback. Historical inactive/unassigned-from-client staff remain displayable. Removed assignee gives null id and null display object. No email, token, lock flags, creator or owner in either new projection. Descriptions remain internal and guarded by persisted staff/client scope.

## Eligibility clarification — preserves existing writer contract

Parent clarification supersedes the ambiguous initial instruction, not existing validated behavior: ADMIN requires an active assignment to this client; SUPER_ADMIN remains globally eligible without an explicit assignment. Both roles require active, unlocked, non-archived, non-pending-identity status. Role alone is insufficient. Shared flags, staff roles and assignment-rule helper drive lookup and existing writer validation without changing behavior. Existing writer, PG, projection and HTTP specifications are byte-preserved.

Task-scoped assigned ADMIN can read this lookup without receiving assignment-management access. Existing transaction/scope locks are reused. Lookup does not reserve eligibility: create/update still revalidate under locks, and revoked assignment after lookup rejects save. Stale history is not an eligible option.

## Verification of record — 2026-10-05

Strict test-first mode: explicitly requested by parent; exact runner below. All resources are owned PostgreSQL 17 Docker tmpfs clusters, verified before writes with unique `exom-rest-t2e-api-*` names, loopback-only ports, `exom_ci` role/database and `/var/lib/postgresql/exom-ci-data`. Environments are allowlisted and repository dotenv reads suppressed. Firebase identity verification is mocked; real guards, Nest validation, controller/service and PostgreSQL execute. No live Firebase, remote database or production fallback.

| Check / exact command | Observed result | Local receipt |
| --- | --- | --- |
| `FOLLOWUP_EVIDENCE_ROOT=docs/evidence/rest-t2e-api-20261005 node scripts/run-followup-tasks-integration.cjs http` RED | 49 prior HTTP tests PASS, 33 new tests FAIL; bootable missing-route 404s and unsupported-query expectations | [RED log](http-a2f3308a-2ceb-4db3-8b30-9e5c7599f19e/jest.log) |
| Same HTTP command, first implementation | 77 PASS / 5 FAIL; test assumptions about shared globally eligible SUPER_ADMIN fixtures, inactive guard 401, transport timestamps corrected; no contract weakening | [Intermediate log](http-3cb3dd68-ceab-4492-b6b3-f038209dad77/jest.log) |
| Same HTTP command, initial GREEN | 2 suites / 82 tests PASS, zero pending | [GREEN log](http-6728daea-0cf8-4293-8226-8d2b861edc67/jest.log) |
| Same HTTP command, final candidate | 2 suites / 83 tests PASS, zero pending; includes create/update parity and observed table-lock interleaving | [Final HTTP JSON](http-f07bb665-4b2c-4cdf-b25f-079d5e94af8f/jest.json) |
| `FOLLOWUP_EVIDENCE_ROOT=docs/evidence/rest-t2e-api-20261005 node scripts/run-followup-tasks-integration.cjs all` | 109 suites / 1323 tests PASS, zero failed/pending; includes prior writer/PG/projection/HTTP and new list/assignee tests | [Full JSON](all-9a0b3c9a-200c-42ab-b7bc-43152a06bac3/jest.json) |
| `npm run lint -- --no-fix` | Initial authored formatting FAIL (145 errors), manually corrected; final PASS, zero errors/two unchanged warnings at progress.concurrency.spec.ts:474/482 | [Sanitized command receipt](checks.json) |
| `npm exec -- tsc --project tsconfig.build.json --outDir docs/evidence/rest-t2e-api-20261005/build --incremental false` | PASS, exit 0; nondeleting isolated output, no default Nest build | [Sanitized command receipt](checks.json) |
| `git diff --check` | PASS | [Command receipt](checks.json) |
| Prisma | NOT_RUN here: unchanged schema; prior T2D generation/validation PASS reused explicitly | [Prior receipt](../rest-t2d-20261005/README.md) |

The lint/typecheck command receipt records the exact environment-prefixed shell commands used. Formatting was corrected only in authored allowed files, without auto-fix or a broad formatter.

Coverage includes all four states and default/intersecting filters; task and assignee empty/beyond-last pages; totals; bounds/forgery; deterministic due/priority/created/id ties; unauthenticated/client/unassigned/cross-client/inactive access; minimal historical display; ADMIN and SUPER_ADMIN flag matrix matched against actual create/update saves; post-lookup revocation; populated task/user/assignment equality across GET; unchanged canonical summary. The coherence test observes a reader blocked by an ACCESS EXCLUSIVE task-table lock while an insertion commits, then checks returned count and rows belong to the same before-or-after result. Actual limits remain bounded and all SQL filter/offset/limit values are parameters. A single SQL statement owns page and total; only the bounded page is JSON-aggregated, not all filtered rows.

## Retained resources and recovery

All five clusters and synthetic fixtures are deliberately retained; no stop, cleanup or deletion performed. Loopback ports: RED 59125; intermediate 52356; initial GREEN 56950; final HTTP 63490; full suite 63946. Each run's `resource.json`, `migrations.json`, `retained-databases.json`, `jest.json` and `jest.log` records ownership, identity and outcome without credentials. Full resource: `exom-rest-t2e-api-1f4c6144-d0af-49b7-9bf5-90e33f72d9a7`, container `eacabe10d07dca6c332dc6275148db796d41bd82b06c4e240e3bac2cfa8ea3f4`.

- [Pre-write snapshot](checkpoint/start/manifest.json): original source/config/probe hashes plus coordination document hashes, taken before source edits. Coordination root `${WORKSPACE_ROOT}/` is non-Git; documents are hash snapshots, not commits.
- [Final recovery manifest](checkpoint/final/manifest.json): source/config/control hashes, receipt hashes, safe `.snapshot` copies and tracked patch. New DTO/spec are included; no copied `.ts` source can pollute compilation.
- Original probe SHA256 remains `8b5ba61a1cf147c643727dbfb2f7139126e6f08647906bb7cf5ad9004ddc8ac4`; existing HTTP SHA256 remains `ea17ebf3f8da699e04325b3c3bc3892024ea73349aeb2975caac55233155202a`.
- Recover from base plus the retained scoped patch and snapshot copies after verifying manifest hashes. Parent owns staging/commit. No Git mutations performed.
- Anchored ignore rules expose only this README under this dated root. Runs, cache/build, JSON/logs and checkpoints are LOCAL ONLY; a fresh clone needs a separate archive to recover them.

## Limits and next permitted action

About 881 authored code/test diff lines before this receipt exceed the initial 400–700 heuristic because the new real-HTTP fixture, full eligibility/save matrix, negative queries and forced PG coherence interleaving remain explicit. No feature/surface expansion: existing tests untouched, no new schema or dependency.

This is local API implementation/verification, not whole T2E/P5 closure. Independent/native review, parent-owned Spanish commit and REST-T2E2 Admin implementation remain pending. No production performance/load, whole-AppModule/bootstrap/live-Firebase proof, exhaustive production/bulk writer deadlock guarantee or full historical training/diet preservation claim is added. The GET preservation test covers populated task/user/assignment fixtures; existing bounded concurrency evidence remains bounded.

## Independent REST-T2E1 API verification — 2026-10-05

**Required checks PASS; source-level sentinel caveat requires parent disposition.** This is not native approval, unit DONE or permission to implement Admin. No source/config/harness/task fixes made.

### Fresh exact evidence
All runner commands used FOLLOWUP_EVIDENCE_ROOT=docs/evidence/rest-t2e-api-20261005.
- PASS node scripts/run-followup-tasks-integration.cjs http — 2 suites/83 tests; failed0/pending0; http-451087df-1f5f-45fb-9917-f11a59488e26/jest.log + jest.json.
- PASS node scripts/run-followup-tasks-integration.cjs all — 109 suites/1323 tests; failed0/pending0; all-90cdbfad-828f-464d-a274-0d387bc841ff/jest.log + jest.json.
Independent JSON inspection confirms new list34 and prior HTTP49 executed/passed in BOTH HTTP and ALL, including flag/save parity, post-lookup create/update rejection, observed blocked-reader insertion and populated read preservation. Preserved historical RED JSON confirms49PASS/33FAIL/zero pending.
- PASS npm run lint -- --no-fix — zero errors/two unchanged progress.concurrency.spec.ts warnings474/482; checkpoint/independent/lint.log.
- PASS npm exec -- tsc --project tsconfig.build.json --outDir docs/evidence/rest-t2e-api-20261005/build/independent --incremental false — exit0/no diagnostics; checkpoint/independent/build.log. git check-ignore verified this output BEFORE generation; no Nest build.
- PASS git diff --check — exit0; checkpoint/independent/diff-check.log.
Runner clears application environment, blanks dotenv via retained privacy preload, verifies fresh owned container/mount/loopback/SQL identity and empty schema before isolated writes; ALL legacy84/timestamp-off prerequisites retained. Lint/build used OS/path-only environment plus NODE_ENV=test, fresh HTTP privacy preload/empty.env and unused localhost port1 URLs. No live Firebase/production fallback.

### Eligibility, contract and coherent reads
Eligible SUPER_ADMIN remains GLOBAL without client assignment; ADMIN requires active assignment, and both roles require active/unlocked/non-archived/non-pending flags. Lookup SQL and locked writer use the same flags/role/assignment helpers. Actual HTTP matrix covers ten flag/role rows against lookup + CREATE + UPDATE, with eligible unassigned SUPER_ADMIN saves succeeding. Client/outsider/inactive assignees rejected; revoked ADMIN lookup result subsequently rejects CREATE and UPDATE without task mutation. Lookup is eligibility discovery, not reservation or bypass of target-client writability/actor authorization.
Both static routes precede :taskId; real guards and inherited scope protect list/lookup. Unknown/repeated/prototype/bad-bound query inputs rejected. Pagination defaults/bounds and view/status intersections are stable as documented; no implicit assignee filter, UUID/unassigned/beyond-last totals tested. SQL params bind owner/status/assignee/roles/flags/limit/offset; no caller-supplied ordering. Both total and page are one PostgreSQL WITH statement snapshot, count owns filtered source and only bounded page is JSON-aggregated. Returning<=100 items is not constant scan cost or load benchmark.
ACCESS EXCLUSIVE fixture forces the actual CTE reader to wait; pg_blocking_pids observes the wait, then insertion commits and response total/items/insert membership agree on one before-or-after result. This is observed interleaving, not merely Promise concurrency. It does not exhaust all production writers or isolate every possible row-writer race.
Task output allowlists descriptions and historical responsibility for internal staff, with profile names/null only; excludes email/token/owner/creator/flags. Stale inactive staff displayed but not offered. Null fixture represents removed assignee; no actual FK deletion was exercised. Read preservation fixture checks tasks/users/assignments, not all metrics/plan/message history. Service summary body byte-identical to base; query factors identical canonical ordering. Four existing unit/PG/projection/HTTP specs byte-identical to base; ALL preserves their execution.

### Source caveat — REST-T2E1-VERIFY-SENTINEL-01
DTO assigned_to_id Matches uses /i, accepting UNASSIGNED; taskListQuery compares exact lowercase unassigned before its UUID/ID branch. Thus accepted uppercase sentinel follows equality against the string unassigned rather than IS NULL. Documented lowercase sentinel works, no authorization leak. Source-level deterministic branch inconsistency; extra HTTP reproduction NOT_RUN because only exact parent-authorized commands executed. Parent should normalize sentinel or reject this accepted alias, with a regression; verifier did neither. Do not represent this finding as an observed failing HTTP test.

### Identity, preservation and retained resources
checkpoint/independent/hash-audit.json verifies17 writer live/snapshot hashes (12source/config/control/probe +2receipt files +3coordination references), all25 historical receipt hashes, and four unchanged control specs against Git base. Candidate source SHA256 1214d48c222f5d826a9378a6918d888b9532b9a405f15442d9c87626047d9724; aggregation policy is recorded in audit. Scoped tracked.patch and twelve safe .snapshot copies recover changed/untracked bytes; original probe intact.
First audit wrapper falsely failed its summary extractor because it searched private readPage( rather than generic private readPage<T>(; corrected extractor only and summary bytes match. No functional check failure was hidden or source altered.
- http-451087df-1f5f-45fb-9917-f11a59488e26: exom-rest-t2e-api-c823c723-50a1-43ca-9be9-6fce12bcf1eb; ID 2ab5e80e8c6cfe3f9e00b61ca06b4a56863630d1d2e662fce0b58b08de73721e; loopback53465; DB/role exom_ci; PGDATA /var/lib/postgresql/exom-ci-data; 2 non-template databases retained. resource.json/migrations.json/retained-databases.json preserved.
- all-90cdbfad-828f-464d-a274-0d387bc841ff: exom-rest-t2e-api-67a98b22-bae6-47e7-8ca3-c29288335ea7; ID ce83f39fa0712a9b7b93e4ae6f760a756346fdc487ec11e0bda15f6b2d6559ea; loopback53918; DB/role exom_ci; PGDATA /var/lib/postgresql/exom-ci-data; 12 non-template databases retained. resource.json/migrations.json/retained-databases.json preserved.
All prior/new logs, failures, resources and original receipts preserved; no stop/delete/drop/cleanup/remote/native/Git mutation. Ignored recovery remains LOCAL ONLY, not fresh-clone archive delivery.

API base/HEAD f28e4f650b8c9328e3da3087a17770782b252634, feat/progreso-adherencia-p4/origin/feat/progreso-adherencia-p4, index empty, nine visible entries unchanged. Only existing README appended plus ignored verification artifacts. Full bootstrap/live Firebase/OpenAPI/UI, production load, complete bulk/lock graphs and comprehensive history NOT_RUN/unclaimed. Parent owns source caveat disposition/native review/Spanish commit; no Admin implementation or broader closure.

## Sentinel correction — REST-T2E1-VERIFY-SENTINEL-01, 2026-10-05

The independent source finding above is now reproduced and corrected locally. Earlier PASS receipts and the original source-only finding remain historical evidence, not validation of the corrected bytes. Parent authorized this correction only; independent/native disposition and commit remain parent-owned.

Actual HTTP RED with two populated null-assignee rows: lowercase `unassigned` returned both, while accepted uppercase `UNASSIGNED` returned HTTP 200 with empty data/total 0. The regression compares lowercase, uppercase and mixed-case aliases against the same complete page. A repeated mixed-case sentinel query remains rejected as non-string input.

Minimal correction: DTO `Transform` lowercases only a string whose case-insensitive value equals `unassigned`; UUID values and other inputs are unchanged. Existing raw-query non-string rejection and validation are preserved. No service/query/controller/eligibility changes.

| Exact command | Observed result | New retained receipt |
| --- | --- | --- |
| `FOLLOWUP_EVIDENCE_ROOT=docs/evidence/rest-t2e-api-20261005 node scripts/run-followup-tasks-integration.cjs http` RED | 84 PASS / 1 FAIL / zero pending; actual sentinel page mismatch | [RED log](http-cff4d1be-3caf-4d09-bce4-eea5a747c6d0/jest.log) |
| Same HTTP command GREEN | 2 suites / 85 PASS / zero pending | [GREEN JSON](http-35707401-0769-446e-a695-f9505ad19ca6/jest.json) |
| `FOLLOWUP_EVIDENCE_ROOT=docs/evidence/rest-t2e-api-20261005 node scripts/run-followup-tasks-integration.cjs all` | 109 suites / 1325 PASS / zero pending; repeated after test-only formatting correction | [Final full JSON](all-9c5213c1-26b6-4541-923d-3aff101bec51/jest.json) |
| `npm run lint -- --no-fix` | Initial one authored formatting error corrected manually; final zero errors/two unchanged warnings | [Sanitized check receipt](checks-sentinel.json) |
| `npm exec -- tsc --project tsconfig.build.json --outDir docs/evidence/rest-t2e-api-20261005/build/corrected --incremental false` | PASS, exit 0, no diagnostics; corrected output already ignored by existing anchored root rule | [Sanitized check receipt](checks-sentinel.json) |
| `git diff --check` | PASS | [Check receipt](checks-sentinel.json) |

Corrected source SHA256:
- DTO: `cefc3767d5bce13ac444473a5d2a96717a3e04e823f359dc397848a4f5435afd`.
- List specification: `728a483c9576fd5256f0ab76e95088f0205ec19ed61b4ef7571e85ff333b9d29`.

[Corrected checkpoint](checkpoint/sentinel-corrected/manifest.json) provides fresh safe snapshots, final full-run hash comparison and hashes for all four new run receipts. The previous writer and independent checkpoints are retained unchanged. Source changes are limited to the DTO and list regression file; other candidate source hashes are checked against the previous checkpoint.

Four additional owned clusters retained without cleanup: RED loopback52528; HTTP GREEN53001; initial full53467; final full53892. Their resource/migration/retained-database manifests preserve identity and limits. Final full resource: `exom-rest-t2e-api-359f4f98-309d-4c20-899a-69dfa0bdf330`, container `72a5602f1f493fd6b4895824996353c90b0abe574587a3a847aebac0af53f352`. Sanitized runner/environment and prior scope limits remain unchanged. No remote/live-Firebase/UI/native/commit operations; no broader closure claimed.

## Current corrected-candidate acceptance — 2026-10-05

**Independent bounded PASS. REST-T2E1-VERIFY-SENTINEL-01 FIXED and regression independently verified.** Historical source-only finding and RED/FAIL chronology above remain intact. This current disposition supersedes earlier caveat/native-pending statements without rewriting their dated evidence.

Fresh exact command: `FOLLOWUP_EVIDENCE_ROOT=docs/evidence/rest-t2e-api-20261005 node scripts/run-followup-tasks-integration.cjs http` — PASS 2 suites /85 tests, zero failed/pending. [Independent corrected HTTP JSON](http-eb49cd19-7541-486c-bdbb-ee407b7b50cb/jest.json) and [log](http-eb49cd19-7541-486c-bdbb-ee407b7b50cb/jest.log). All36 list assertions and49 prior HTTP execute; lower/upper/mixed-case populated-null-page equivalence and repeated mixed-case rejection pass.
Independently inspected preserved RED JSON:84PASS/1FAIL/zero pending, actual uppercase empty page versus two lowercase null rows. Final writer ALL JSON `all-9c5213c1-26b6-4541-923d-3aff101bec51/jest.json` verifies109 suites/1325PASS/zero failed/pending and36 new list tests. ALL was NOT rerun independently for this acceptance; source identities match final full-run manifest. Corrected lint/build/diffcheck PASS recorded in checks-sentinel.json inspected, not independently rerun.
Only DTO and list spec changed relative to the previously independently tested candidate: DTO sentinel-only string normalization, two regression assertions/tests; no service/query/controller/harness/ignore/eligibility change. Eligible SUPER_ADMIN global and ADMIN active-client-assignment rules plus both-role flags remain unchanged. Four prior control specs and original probe remain byte-identical. No authorization weakening or unconditional save reservation.

**Parent-supplied native approval:** `review-7fd9ad9d6d99c333`, approved exact ACK consumed, authority burned. Target `sha256:d9d3a01e703cbe23fdc9bae4395b4e6e714ee33023a4a25fa9fc03b79cbd82e6`; consumed revision `sha256:61d32c5c95fbbc1b881f121f3d78c9ad8403c867979ad628fde9773af5043097`. No verifier native lifecycle invocation; no invented advisory description.

**Nonblocking follow-up R3-retained-assignee-pagination:** OPEN, informational WARNING; location client-followup-tasks.list.spec.ts:180-200. Exact description NOT_PROVIDED. Owner: later harness/coverage unit. Acceptance: inspect retained-assignee pagination test independence, record justified conclusion and warranted targeted coverage without weakening eligibility. No assertion of an undisclosed defect and no correction transition.

[Corrected independent checkpoint](checkpoint/independent-corrected/manifest.json) and [audit](checkpoint/independent-corrected/audit.json) record twelve corrected source/control/config/probe identities, snapshots/full-test consistency, correction scope, all45 original/correction historical receipt hashes preserved, resource identity and parent commit preflight. Source aggregate SHA256 6dc3169285d32b0405aa8ac8eaf0a1b58d22546fce0ccf9835ac222ad2e04899 uses the same sorted file-NUL-hash-newline policy as prior independent audit.
DTO SHA256 cefc3767d5bce13ac444473a5d2a96717a3e04e823f359dc397848a4f5435afd; list spec SHA256728a483c9576fd5256f0ab76e95088f0205ec19ed61b4ef7571e85ff333b9d29. Safe corrected .snapshot copies/scoped tracked patch retained; no previous checkpoint overwrite.
Fresh retained resource: exom-rest-t2e-api-05a6b864-40d8-4b47-b44f-249d27fc4b82; ID 93e3e5184b06b40521205342b28b73f77a23fb1ceb62e3ab4a189ca1a46de737; loopback60528; DB/role exom_ci; PGDATA /var/lib/postgresql/exom-ci-data. resource.json/migrations.json/retained-databases.json remain in fresh run directory. All old/new resources preserved, no shutdown/delete/cleanup.

Read-only parent preflight: feat/progreso-adherencia-p4/origin/feat/progreso-adherencia-p4 HEAD/base f28e4f650b8c9328e3da3087a17770782b252634, index empty, nine visible entries unchanged; no active commit hooks detected. Sources ready for parent-owned explicit local Spanish commit; original probe and ignored artifacts remain excluded. Parent owns staging/commit/scoped closure. No source/task/config edits, native rerun, remote operations, Admin/UI/P6 or broader closure. Existing bootstrap/liveFirebase/performance/deadlock/history limits retained. Recovery remains LOCAL ONLY.
