# REST-T3A — additive review persistence

> Copia saneada para entrega: ubicaciones normalizadas; resultados, fechas y hashes conservan su significado histórico y corresponden al snapshot privado original, no a esta copia. WORKSPACE_ROOT identifica la coordinación; SDK_ROOT el SDK instalado; RUNTIME_ROOT las herramientas locales; TEST_ARTIFACT_ROOT los recursos privados retenidos, no publicados.


Writer evidence, 2026-10-05. Implementation and focused verification only; parent owns independent verification, native review and local commit. Later bounded runner/full-suite verification is recorded separately in [full-suite-followup.md](full-suite-followup.md); the scoped chronology and hashes below remain historical, not silently replaced. This does **not** close REST-T3 or P5, implement publication endpoints, update clients/printing, or apply a remote migration.

## Current disposition — APPROVED and verified, local commit pending

Parent-reported final native inspect: target `sha256:275e6733be385fb489ee64e1736bc9174a1fb4f51d2f1600dcc91e48d39e08e1`, tree `e9eb0bad55b4c281c5ef85f8c97c6d3e039a91ba`; selected exactly seven source/config paths (schema, migration, integration test, runner, service, service spec and `.gitignore`), excluding the unrelated original probe and passive documentation.

Current parent-reported native disposition supersedes only the earlier pending-review state: `review-40d2d548c1c98278` is **approved**, and the exact acknowledgement was consumed for revision `9e90565271ce331056f93c854d3098623a3fc7f681f43ac0494ef9b1978928a0`, matching the target/tree above. No commit has been created for this unit. One informational, nonblocking finding, **R3-runner-portability**, points to `scripts/run-recap-review-persistence.cjs:35`; defer to separate later work, without inventing details or reopening this approved unit.

Historical consent attempt: START host consent expired after ten unanswered minutes, with `lineage_created=false`, `nativeinvocation=false`, `mutation=none`; at that stopping point there was no approval or decline and the proposed review had not been created. The historical checkpoint preserves that state; the later parent-reported approval/ACK above is now authoritative.

Independent verification reported by parent: 25 unit tests / 4 real-PG migration tests and generate/validate/nondeleting tsc/lint checks PASS (0 errors / 2 existing warnings). The independent no-DB full suite remains environmental **FAIL** (48 FAIL / 864 PASS / 406 SKIP). Subsequent corrected writer full suite is **PASS: 109 suites / 1329 tests, zero skipped**; this is not an independent full-suite rerun. Historical failures below and in the [launcher follow-up](full-suite-followup.md) remain unchanged.

Current recovery checkpoint: [approved precommit manifest](checkpoint/final-approved-commit-pending/manifest.json), full tracked patch and explicit authored `.snapshot` files. The earlier [pending-review manifest](checkpoint/final-pending-review/manifest.json) remains unchanged as historical evidence. Generated runs, caches, builds, resource credentials and recursive checkpoint copies are excluded. Checkpoint is ignored and LOCAL ONLY; archive it separately for fresh-clone recovery.

Exact pending work: parent-owned local commit of the seven reviewed source/config paths and two passive receipts (`README.md`, `full-suite-followup.md`), excluding the original probe and generated artifacts. Native approval/ACK is satisfied; no repeated step-consent is required under the user's explicit continuation through P5. After that commit, pre-existing client mutation `admin_comments` exposure is separate **REST-T3-PRIVACY-01**, next privacy unit before P5 closure. REST-T3B/publication endpoints and broader REST-T3/P5 criteria remain pending. This documentation worker starts none of those implementation units.

## Identity and scope

Coordination root: `${WORKSPACE_ROOT}/`, non-Git. API checkout: that root's `exom-api`; branch/upstream `feat/progreso-adherencia-p4` / `origin/feat/progreso-adherencia-p4`; unchanged HEAD `224e7b0051ff0f96821ebd95aad0a171106bc683`. Initial status contained only unrelated `scripts/probe-client-deletion-lock-order.cjs`; preserved SHA256 `8b5ba61a1cf147c643727dbfb2f7139126e6f08647906bb7cf5ad9004ddc8ac4`. Index untouched.

Read root AGENTS, current remaining-phases task, and applicable plan criteria. Parent explicitly authorized REST-T3A-PROJECTION-01 before edits. Root AGENTS SHA256 `f21dc8259e9ff8b7a02122efd9b1651a4a22859081c6871722b099c8476a38db`; plan `8322fb624e1c0e54c51c071c7e90a1a2bdd957c9c33374274c80afb78eb2db16`; current task `3ba80a257a2c293d4f8a011de36567a041fa535cf7409b17ad69deb8eff1b96e`.

Migration timestamp `20261005210000` was confirmed vacant before creating the migration; 91 prior migration directories existed. New migration is one ALTER TABLE with seven ADD COLUMN clauses only: six nullable TEXT columns `draft_coach_summary`, `draft_changes`, `draft_next_week_goals`, `published_coach_summary`, `published_changes`, `published_next_week_goals`; required INTEGER `review_version` DEFAULT 0. No text backfill or legacy lifecycle updates.

## Projection audit and causal fix

CodeGraph query preceded source mapping. Client GET list/detail already use explicit scalar selects. Client create (both branches), update and submit previously returned unrestricted Prisma rows. Four populated-review regression cases reproduced automatic exposure; these mutations now use a shared explicit legacy scalar allowlist. All previous scalar fields remain, including `admin_comments`; no new review fields are serialized. Existing assertions still check writes, submission timestamps and notifications.

Other inspected readers: Dashboard metadata, metrics overview and adherence evaluation use explicit selects; notification scheduling is internal. Admin detail/review/archive remain unrestricted intentionally, as authorized staff routes. No new GET published projection or writer was introduced. Pre-existing client mutation exposure of `admin_comments` is preserved rather than silently changing that unrelated legacy contract; it needs separate disposition.

## Observed chronology (FAIL is retained)

Commands run foreground from API root, with no production dotenv/fallback. Logs and exact child command arguments are retained in each run folder.

| Command | Run folder | Observed result |
| --- | --- | --- |
| `node scripts/run-recap-review-persistence.cjs unit` | `run-unit-2d2ac5f8-02a3-47ea-9493-c4bb49719562` | RED: 21 PASS / 4 FAIL; all four client mutation branches returned seven populated review fields. |
| `node scripts/run-recap-review-persistence.cjs pg` | `run-pg-029b3425-5b48-4aec-bd55-9e2dc16ea715` | FAIL: runner URL-construction defect stopped migration tests at same-cluster URL validation; not behavioral RED. Fixed using URL.pathname, not string replacement. |
| `node scripts/run-recap-review-persistence.cjs pg` | `run-pg-bd35e1c2-3f39-49f0-a636-45b7da37ab05` | RED: 3 FAIL; zero of seven columns present, defaults absent, PostgreSQL reports missing published_coach_summary. |
| `node scripts/run-recap-review-persistence.cjs unit` | `run-unit-0fb64324-1dcf-45a4-bd39-80541fd6c27e` | GREEN: 25 PASS / zero pending. |
| `node scripts/run-recap-review-persistence.cjs pg` | `run-pg-23498301-b2f9-41b2-8b24-15de2b2a2c5b` | GREEN: 3 PASS / zero pending. |
| `node scripts/run-recap-review-persistence.cjs checks` | `run-checks-1075c033-4599-47bd-a7b7-c785b75f462b` | FAIL after generate/validate/tsc PASS: ESLint package exports reject bin subpath. Fixed executable resolution through package.json. |
| `node scripts/run-recap-review-persistence.cjs checks` | `run-checks-749bd087-384f-46e3-b699-72d07d1424e8` | FAIL: 41 authored formatting errors; two existing progress-concurrency warnings. Targeted formatting edits only, no lint autofix. |
| `node scripts/run-recap-review-persistence.cjs unit` | `run-unit-07b1656d-b2a0-4fba-8aa0-c8871b62aa55` | Final PASS: 25 tests / zero pending, regenerated Prisma metadata includes review fields. |
| `node scripts/run-recap-review-persistence.cjs pg` | `run-pg-7926b813-d119-4d73-ba0d-6714cf04f69b` | Final PASS: 4 tests / zero pending. |
| `node scripts/run-recap-review-persistence.cjs checks` | `run-checks-70bd2d45-f44b-4c6b-9eab-b9f0636c2f70` | Final PASS: Prisma 7.10 generate/validate, isolated nondeleting tsc, lint (0 errors / 2 existing warnings), git diff --check. |

Final PG coverage: fresh installation of 92 migrations; upgrade of 91 prior migrations with populated synthetic DRAFT/SUBMITTED/REVIEWED+archived recap fixtures, exact legacy fields/timestamps/whitespace/Unicode and populated user/metric/streak preservation; schema metadata equivalence; all new text initially null and version zero; independent draft edits retain published content and legacy fields; fresh legacy-shaped INSERT defaults; null version rejected with SQLSTATE 23502. Persistence independence is SQL-level evidence, **not** implemented explicit-confirmation or optimistic-concurrency API behavior.

## Resource identity and retention

Every PG run creates its own Docker PostgreSQL 17 instance from the already installed `postgres:17-bookworm` image, no image pull fallback. Before DB writes, runner verifies full container ID/name/ownership label, running state, loopback-only random port, tmpfs-only mounts and PGDATA; SQL verifies database/role/data directory and empty public schemas. Upgrade URL must identify the same owned cluster. Credentials exist only in process/container environment, never receipts or source snapshots. Child environment is allowlisted; dotenv sync reads return empty content. No production environment files were loaded.

Final instance: `exom-rest-t3a-dc388c75-f999-4fea-8921-801596819d34`, container ID `f18539aa668919829e7f67b2f9e12a15cabdfadd0d6a3e66405eb0a521ebdebe`, `127.0.0.1:63024`; databases `exom_ci` and `exom_ci_recap_upgrade`, role `exom_ci`, data directory `/var/lib/postgresql/exom-ci-data`. All four created instances, databases and evidence retained. Each PG folder has sanitized `resource.json`. No drop/reset/revoke/shutdown/cleanup or destructive rollback was executed; closing test connections does not stop PostgreSQL.

## Checkpoint and source hashes

Final source snapshots and all 92 migration hashes: [manifest](run-checks-70bd2d45-f44b-4c6b-9eab-b9f0636c2f70/manifest.json). The final unit/PG/checks source sets match; snapshots end `.snapshot` and cannot become compilable TypeScript. Logs, caches and isolated build output stay narrowly ignored under this dated root. They are LOCAL ONLY and need separate archival for fresh-clone recovery.

| Source | Final SHA256 |
| --- | --- |
| schema | `28943ef25c2a6ea59508f6b0376336131b3b786f28cfd58fb6a30952d502e129` |
| migration | `64f80dd335c62fc412fd4206edb4a62bc00b59ed3137088b9ba293ab2dc13916` |
| integration test | `825f39722b982b98a04088983b55cbd1dbd2c9db7b0e3fb30b5d228e681e08b6` |
| runner | `f81eadf700f336bc1fe83d7ec6a5d0f82cad72e3eb2ab30b9a9d7eee404a25f9` |
| service | `d8bc77abf0b020876bb9c2d3ba697620953a3324744c551003b574d69b7e05fb` |
| service test | `740548777cffd77d62b2a15772da971dfb9be6a9668093d33a2e0e5c72fb4af5` |
| ignore | `ced14d2639e6929eeec088383ceceb7a371da43f100d49b2be16c7e61b363798` |

Recovery guidance (not executed): retain additive columns/data; restoring prior application code does not require dropping them. For source recovery, use unchanged base HEAD plus hash-verified final snapshots and this receipt, applying copies only with parent authorization. Never destructively roll back populated review columns; any later repair must separately identify target/data population and recovery authorization. There is no backfill to reverse.

Limits: representative history fixtures, not every domain table; no full suite/HTTP/live Firebase/API/Admin/App/print/deployment validation. Parent verifier will own broader checks and review disposition. REST-T3B remains the next publication/version-checked API unit, not started here.
