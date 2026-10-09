# REST-T3-PRIVACY-01 — client recap note privacy

> Copia saneada para entrega: ubicaciones normalizadas; resultados, fechas y hashes conservan su significado histórico y corresponden al snapshot privado original, no a esta copia. WORKSPACE_ROOT identifica la coordinación; SDK_ROOT el SDK instalado; RUNTIME_ROOT las herramientas locales; TEST_ARTIFACT_ROOT los recursos privados retenidos, no publicados.


2026-10-05: implementation independently verified and native review approved; local commit follows this receipt. Independent unit25 and full109 suites/1337 tests PASS, zero skipped; generate/validate/nondeleting tsc/lint PASS (0 errors/2 unchanged warnings). Independent receipts under `../rest-t3a-20261005/run-unit-ce362984-66b1-4aae-9d47-049ebf1d8750`, `run-all-69da7c81-b087-4fe1-8372-83cb0c786189`, and `run-checks-eea86c19-4fa9-404a-86f0-8a1381cb86c9`. Native `review-685e4572776fa7aa` approved without advisories; exact acknowledgement consumed revision `071808a3f07cedc3a15353d30a252b644a8eca03611f3218e74d8aa18d06518a`, target `2645dc64bc69b3ebdc886f54800845eaeae716cbec0016ea9895c6f725d7b516`. Not publication API or P5 closure. Historical writer details follow.

## Identity, defect and minimal correction

API root `${WORKSPACE_ROOT}/exom-api`; branch/upstream `feat/progreso-adherencia-p4` / `origin/feat/progreso-adherencia-p4`; base/unchanged HEAD `4b2a906d3aae1b08d21b31d4985a408856a88c0b` (committed T3A; not reopened). Initial tree contained only unrelated `scripts/probe-client-deletion-lock-order.cjs`; preserved SHA256 `8b5ba61a1cf147c643727dbfb2f7139126e6f08647906bb7cf5ad9004ddc8ac4`. Index untouched.

Confirmed pre-existing defect: the mutation-only scalar select included `admin_comments`, unlike client GET/list. Removed that extra select and reused `CLIENT_RECAP_SELECT` on create's two branches, update and submit. No database update policy, lifecycle, feedback, notification, admin authorization or schema change. All seven draft/published/version fields remain excluded.

T3A's four populated-review tests now assert **39 shareable legacy scalars**, not 40 scalars including private notes. This is the specifically authorized privacy correction, not weakening coverage: exact equality still protects every shareable scalar, asserts the count, and now rejects a populated internal note as well as all seven review fields. Stored/admin notes are separately asserted intact. Three existing write assertions retain their data/timestamp requirements and now assert shareable feedback selection instead of private-note selection.

## Audit and compatibility

- `src/modules/recaps/recaps.service.ts:26–67`: canonical 39-field client scalar allowlist excludes internal notes and new review storage.
- Mutation writers/selects: create `:242`, selects `:300/:337`; update `:341/:367`; submit `:371/:392`. Only their response projections changed.
- Equivalent client readers: findMyRecaps `:396/:403`, getMyRecapById `:411/:414` use the same allowlist; markClientFeedbackAsRead `:428` selects only lookup/feedback metadata and returns `{ success: true }`.
- Authorized admin listing retains notes in `ADMIN_RECAP_LIST_SELECT` (`:76`); admin detail `:521` retains the restricted-access raw row; review writers `:525/:555–578` still write internal notes only through the existing authorized staff flow. No admin source behavior changed.
- `src/modules/recaps/dto/create-recap.dto.ts:15/:175`: Create/Update allow only client-answer fields. `admin_comments` and shareable coach feedback are staff ReviewRecapDto fields (`:177–201`); review storage fields are absent. Production `src/configure-app.ts:23–27` has whitelist + forbidNonWhitelisted. HTTP tests reject note, review storage and coach-feedback fields in both client DTOs.
- Read-only App audit: `../exom-app/lib/features/recap/data/models/recap_model.dart`, `RecapModel.fromJson`, maps answers/shareable feedback and requires id/week dates/created_at; it does not read `admin_comments` or any new review storage. Those actual required/shareable keys remain unchanged. Static parser compatibility is demonstrated; no Flutter/runtime/build validation is claimed.

## Behavioral verification and interruption chronology

Parent authorized the unchanged runner's new unique run directories under the earlier T3A evidence root. No historical run/receipt was modified. Run names below resolve under `../rest-t3a-20261005/`; each has logs and JSON reports/child command receipts.

| Exact command | Run | Observed result |
| --- | --- | --- |
| `node scripts/run-recap-review-persistence.cjs unit` | `run-unit-ed5b25fd-0133-43f6-a55c-eca3960e238a` | RED: 21 PASS / 4 FAIL, populated internal note leaked on every mutation branch. |
| `node scripts/run-recap-review-persistence.cjs all` | `run-all-afb8ba14-aa72-4af7-a183-3b0321b97c87` | RED: 107 PASS / 2 FAIL suites, 1329 PASS / 8 FAIL tests, zero skipped. Four service cases and four actual HTTP/PG mutation serializers leaked notes (new create exposed even its null note property). |
| `node scripts/run-recap-review-persistence.cjs unit` | `run-unit-eabadf2f-fcca-4f0f-b78f-1286f321775a` | GREEN: 25 PASS, zero pending. |
| `node scripts/run-recap-review-persistence.cjs all` | `run-all-f3700f6a-f1fb-4d17-aa34-c8a4a6991e42` | GREEN: 109 suites / 1337 PASS, zero pending. |
| `node scripts/run-recap-review-persistence.cjs checks` | `run-checks-b0d80250-f92f-401a-81e3-45ddd4a4c899` | Cancellation interrupted delivery, not a PASS. Resume observed runner/child PIDs still live and did not duplicate them. They completed: generate/validate/tsc PASS, lint FAIL (2 authored test errors; 2 existing warnings). Diff check not run there. |
| `node scripts/run-recap-review-persistence.cjs unit` | `run-unit-24606747-589e-4dd9-b5b8-5d3d3d302fdf` | Final PASS: 25 tests, zero pending. |
| `node scripts/run-recap-review-persistence.cjs all` | `run-all-8e5decab-cc79-4342-91d7-b411aebef850` | Final PASS: 109 suites / 1337 tests, zero failed/skipped/pending. |
| `node scripts/run-recap-review-persistence.cjs checks` | `run-checks-0968dcf6-e18c-4fc4-b5f9-3eeb2e4eb405` | Final PASS: Prisma generate/validate, isolated nondeleting tsc, lint without fixes (0 errors / 2 unchanged progress-concurrency warnings), diff check. |

Resume corrected the nested asymmetric matcher unsafe assignment and one test formatting line, preserving the paginated-row membership assertion; final full suite repeated after those edits. Initial read-only liveness query had a regex quoting error; corrected query identified the live processes, then observed termination before reruns.

Eight added HTTP/PG cases in `recaps.controller.spec.ts` run through actual Nest routing, validation, real RolesGuard, real RecapsService/Prisma and owned PostgreSQL. Identity middleware supplies synthetic claims; this is not live Firebase/JWT authentication or full production-bootstrap evidence. Four mutation cases also exercise client detail/list/read-feedback serialization, preserve populated SQL `admin_comments` and all review storage, and verify authorized SUPER_ADMIN detail still returns exact whitespace/Unicode notes. Further cases reject both client DTOs' privileged fields, deny client admin routes/staff client writes and deny cross-owner detail/update/submit/read-feedback. No notifications are sent. New creates naturally start with null notes; populated notes on that branch are additionally protected by the service regression.

## Isolation and retained resources

Unchanged runner creates owned PostgreSQL 17 containers with full ID/name/ownership-label checks, loopback-only random ports, tmpfs-only mounts, SQL database/role/data-directory verification and empty-schema checks before writes. Main schema has 92 migrations; separate legacy84 template supports existing concurrency suites. Matching sanitized DB aliases, tracking OFF, explicit test-only SSL disable and PG flags are supplied without incoming/production dotenv fallback. No installations, remote writes, global cleanup/drop/truncate, shutdown or resource deletion.

Final resource: `exom-rest-t3a-4a237126-e8d3-4074-b282-4887aed80249`, ID `1f40b15e5e66faa8c41fb5c4dd267a6bf35ce251c984181aaca4e2f2a5836090`, `127.0.0.1:60882`, role `exom_ci`, PGDATA `/var/lib/postgresql/exom-ci-data`; databases `exom_ci` / `exom_ci_history_legacy_7f814563` plus retained suite clones. All three new all-run resources, synthetic fixture rows and original resources/evidence remain retained; only test connections close.

## Exact candidate hashes and review handoff

| Source | SHA256 |
| --- | --- |
| `src/modules/recaps/recaps.service.ts` | `96e0f5bc775f33068132cfd3b29ded95c0c0db4919bc13745937f8cd9cb0a795` |
| `src/modules/recaps/recaps.service.spec.ts` | `37d53950f69043ac47e21d735792e9e9a31ee4d201ae2339733b7cd66eacc50d` |
| `src/modules/recaps/recaps.controller.spec.ts` | `367a26067938b54d3c19f2207d4203293406bec443573977b7eef365a12df801` |

Tracked patch SHA256 `16102ffba4f47cfef8a9dcbbf47c291109df6ab4aed0f0f8bd75240dff40741f`; 3 tracked files, 261 additions / 18 deletions. Schema/migration/runner/ignore hash comparisons against committed HEAD PASS. `git diff --check` PASS; original probe unchanged. Runner manifests cover service/spec but not controller spec; its exact final hash is recorded here separately. Ignored run artifacts are LOCAL ONLY; no standalone checkpoint outside authorized surfaces was created.

Ready for independent parent verification and review of these three source paths plus this passive receipt. Native review/local commit remain parent-owned and pending. This resolves the bounded implementation defect but does not itself close P5 or start publication/version-checked APIs.
