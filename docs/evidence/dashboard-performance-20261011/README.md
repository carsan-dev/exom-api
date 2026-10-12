# Dashboard performance — PERF-01 local baseline

Measured 2026-10-11 against API base `a82c38cb45ee919fe8e6ba021fe62a7e227b2bb9`. Instrumentation only: no production service optimization, contract change, deployment or production measurement.

## Reproduce safely

Run from the API checkout: `node docs/evidence/dashboard-performance-20261011/benchmark-dashboard.cjs --baseline`. Requires the existing local Docker named-pipe context and pinned PostgreSQL 17 image; no image pull. The existing owned runner verifies immutable image/container identity, tmpfs, loopback and empty destination before full migrations and synthetic fixture writes. Resources remain retained; cleanup must target only verified owned identities.

Each dataset uses a fresh child process, frozen UTC date 2026-10-11, deterministic fixture generator, 200 assigned clients and 30/1825 history days. Measure eleven request families sequentially (first request plus five warm repeats), then one parallel burst. First request is **not database-cache-cold**. Session bootstrap is additional to the Dashboard request map; shared weekly data is measured once. Actual current Nest services, transforms and guards handle HTTP requests; synthetic Firebase token verification is a test seam, **not production JWT proof**. Outsider profile403 and separate-client summary isolation passed.

Query counts/time come from actual `pg.Client.query` completions, not mirrored SQL. DB time sums round-trip completion times; overlapping queries are additive, not server-exclusive CPU. Complete JSON bodies are retained; canonical hashes sort object keys only, preserve arrays and every field, and remove no timestamps. Warm and parallel payload equality passed for every endpoint. Fixture hashes cover descriptor/counts, **not a physical database inventory**; deterministic generator bytes are separately pinned. Future before/after comparisons must pin fixture generator and baseline harness, compare production-source manifest entries separately from intentionally changed harness/runner entries, and never call a changed harness manifest identical.

## Ranked observed results

Times in milliseconds; warm=median of five, range=min–max; DB=warm median; parallel=individual request in the burst. These are bounded local synthetic results, not production claims.

### 30 days — parallel critical path 351.8ms

|Endpoint|First|Warm|Range|Parallel|DB|Queries|Bytes|
|---|---:|---:|---|---:|---:|---:|---:|
|adherence|255.8|159.4|157.1–166.9|349.1|134.8|148|35869|
|month|41.6|24.5|22.6–27.4|183.3|23.0|22|4047|
|selector|96.4|23.4|21.7–41.5|148.8|11.4|5|121501|
|week|22.7|22.3|21.6–23.6|195.2|22.8|22|220|
|metrics_history|25.6|19.9|19.0–20.9|176.6|12.4|14|23631|
|metrics_30d|18.5|19.5|19.1–20.0|175.3|12.3|14|23631|
|summary|15.3|12.9|12.2–15.0|149.7|9.2|11|475|
|profile|20.4|6.9|6.8–8.4|128.6|5.8|6|5830|
|recaps|9.6|6.9|6.6–8.6|128.0|5.3|5|1678|
|day|7.8|6.1|6.0–6.2|155.2|3.4|4|1323|
|session|6.8|5.2|4.8–6.6|127.1|2.7|3|141|

### 1825 days — parallel critical path 391.7ms

|Endpoint|First|Warm|Range|Parallel|DB|Queries|Bytes|
|---|---:|---:|---|---:|---:|---:|---:|
|adherence|239.6|154.9|154.1–156.6|388.8|132.2|148|35869|
|metrics_history|165.5|139.2|129.0–143.8|283.8|79.0|57|57382|
|month|42.1|23.6|23.3–26.3|187.7|23.7|22|4047|
|week|24.3|23.1|22.1–23.7|206.3|22.6|22|220|
|selector|98.9|22.6|21.2–39.2|136.7|10.6|5|121501|
|metrics_30d|19.5|19.3|18.9–20.1|172.7|12.7|14|23631|
|summary|14.7|12.1|11.7–12.7|138.1|8.9|11|475|
|profile|19.5|7.9|7.5–8.7|116.5|7.0|6|5830|
|recaps|9.3|6.9|6.7–7.1|116.3|5.5|5|10521|
|day|7.6|6.3|6.1–9.6|140.3|3.5|4|1323|
|session|6.9|5.8|4.6–7.5|112.9|2.7|3|141|

Adherence dominates both local bursts; historical metrics grows from 14 to 57 queries. PERF-02 must investigate these measured paths without discarding historical fields or prescribing a replacement endpoint.

## Exact evidence and verification

- 30-day successful run: `run-30-2417eaa7-0fd6-4280-a123-e741ef1017ee/`.
- 1825-day successful run: `run-1825-1b2f2957-f813-4032-b3f2-58d79b00f23d/`.
- Each contains `measurement.json` (complete synthetic responses/samples), `fixture.json` and `manifest.json` (before/after source hashes identical). Both manifest SHA256: `ce4d016669695ba20614f1b4c160266446e2ee259db70c45760abef71418726c`.
- Harness SHA256: `ca2343d7194423f904252b03f466d94bfc1018bb386f54ac879fab8b2077ef86`; test SHA256: `b5479b4496209b8a1b3dec2fd9e4e71e1ad22b85a28502a2da2c5f6bffd3f37d`; runner SHA256: `c274dce50248382b31595bc63469bcece7a11592f4151c2b5a46ce71f5abd282`.
- Descriptor fixture hashes 30/1825: `90f5a68838e1998bedfa205e5514bbff741e2dff57d67f99ed120d5919f863f8` / `fdc300648e21666c865942eec0c5235906116f54285fcdcdf85623906233f74e`.
- `node --test docs/evidence/dashboard-performance-20261011/test.cjs`: PASS 3/3; attribution RED previously observed (`0 !== 2`) before implementing instrumentation. Parent independently repeated PASS 3/3.
- `node --check docs/evidence/dashboard-performance-20261011/benchmark-dashboard.cjs` and `node --check scripts/run-recap-review-persistence.cjs`: PASS.
- Existing applicable runner self-check `node scripts/run-recap-review-persistence.test.cjs`: PASS. The initially suggested evidence-folder runner-test path does not exist.
- Exact baseline command above: PASS both datasets. `git diff --check`: PASS tracked diff; new-file staged check pending parent.
- Earlier runs `run-30-aefa2e8f-a22d-457b-b08e-9b9f32cd5b2b` and `run-30-1316fe3e-1fdc-4d85-a380-f69631259ffc`: FAIL on fixture field/UUID validation, retained honestly and corrected before successful runs. No failed attempt is counted as PASS.

**Publication boundary:** `local.log`, environment helpers/logs and resource identity files are local coordination material, not public evidence. Do not publish them, private paths or token values. Publish only inspected synthetic measurement/fixture/source-manifest artifacts. All four attempt resources remain retained; no broad cleanup occurred. Full application suites, production validation, optimization and deployment are NOT_RUN for PERF-01.

Rollback boundary: remove the two newly authored harness/test files and revert only the added `database` export from `scripts/run-recap-review-persistence.cjs`; preserve unrelated probes, P6 artifacts and dated evidence. No production code/schema rollback is required. Source instrumentation delta 241 lines; README is additional passive documentation. No commit/review/publication performed by this writer; PERF-01 commit identity pending parent.

## PERF-02 — measured adherence batching, local candidate

PERF-01 was subsequently committed by the coordinator as `ee63804bfd9973b265640d015d51c90a46f820f2`. This uncommitted candidate batches only exact collected closed prescriptions, nonfuture progress/receipts and complete matching weekly recaps inside the existing authorized locked transaction. Single-day readers, today basis, revision point reads/writes, digests, locks and isolation remain intact. No cache, UI, metric algorithm, DTO, schema or migration changes.

|Dataset|Adherence warm before→after|After range|Queries before→after|DB median before→after|Parallel burst before→after|
|---|---|---|---|---|---|
|30 days|159.4→69.2ms|66.7–74.0ms|148→58|134.8→62.2ms|351.8→247.4ms|
|1825 days|154.9→68.0ms|67.3–72.0ms|148→58|132.2→61.3ms|391.7→296.6ms|

After-run evidence: `run-30-80ca9813-55d4-4fb6-863f-effac1379de0/` and `run-1825-542783a7-1546-459d-8ed2-88673472388d/`; complete raw responses retained untouched. Historical metrics remains the longest warm endpoint for long history (136.8ms); no further optimization implied or applied.

**Cross-run raw hashes are not all equal:** eight endpoint hashes match exactly; selector/profile/day differ only in 202 freshly generated fixture leaves: selector's 200 `data.data[i].profile.id` values, `profile.data.profile.id`, and `day.data.diet_history[0].captured_at`. All eleven payload byte lengths match. Profile creation omitted explicit IDs in the pinned baseline generator; snapshot creation time comes from the local database clock. This is fixture volatility, not a production-field exemption or physical-database identity claim.

The coordinator explicitly accepted scoped synthetic comparison: `compare.cjs` requires exactly those 202 differences, real unique UUIDs with owner/primary-client consistency and no cross-run identity alias, and exact ISO snapshot time within retained resource-file creation→measurement-file modification windows. It substitutes only those verified leaves for comparison, retains every field/order/type/cardinality, and rejects unrelated mutation, extra/missing IDs, aliases, reordered arrays and invalid/out-of-window time. Both runs passed eleven canonical hashes/equal bytes, with exact maps/windows/statistics in each after-run `comparison.json`. No production response or original baseline was normalized.

Reproduce each comparison: `node docs/evidence/dashboard-performance-20261011/compare.cjs <original-run-directory> <after-run-directory>` using the paired directories above. The comparator verifies measured baseline/after fixture descriptors and pinned harness/runner hashes; its newly extended tests were added after measurement, not silently included in the original baseline manifest.

### Final verification and chronology

- Deterministic service RED: three cases observed 7/7/8 point progress reads instead of zero. Final focused command `npm test -- --runInBand src/modules/adherence/adherence-evaluation.service.spec.ts src/modules/adherence/adherence-prescription.service.spec.ts`: PASS 45/45. Exact disjoint dates, owners, future exclusion and complete-week filters asserted.
- Comparator RED 2→GREEN 5/5 via `node --test docs/evidence/dashboard-performance-20261011/test.cjs`; comparator syntax PASS. No fragile wall-time assertions.
- Exact `npm run test:adherence:on` and `npm run test:adherence:off`: BLOCKED by existing repository `.env` existence policy; no file moved/read and no ambient DB fallback. Authorized equivalents use existing `database`/`environment` immutable owned guards. OFF equivalent: full source Jest selection plus exact `npm run test:concurrency`; ON equivalent: existing `onJestConfig()` and `PG_SUITES` (five registered adherence PG suites) plus `src/modules/adherence/adherence-commit-resolver.concurrency.spec.ts`, `--runTestsByPath`, `--runInBand`, `--detectOpenHandles`. Selection validation requires every actual selected case, zero pending/open handles. Do not label blocked wrapper commands PASS.
- Guarded concurrency PASS 390/390 (`run-verify-concurrency-7f77b03f-180f-424c-83b2-eb26c4626c93/`); ON selected PG suites PASS 77/77 (`run-verify-adherence-on-d83067a7-4ed9-4bab-8d0e-d83c1ee776f0/`). Production/PG bytes remained identical afterward. Existing actual-PG tests cover blocked-PID locking, revocation, exact-week recaps and historical policy/evidence; strengthened repeated/concurrent calls preserve revision count and denied calls append nothing.
- Initial full source PASS 1424 followed by candidate lint FAIL 10 unsafe unit-mock access errors. Assertions were corrected without casts, suppression or weakened expectations; focused PASS 45. Final guarded full source rerun PASS 1424, final lint `npm run lint -- --no-fix`, build `npm run build`, contracts `npm run contract:check`, comparator tests PASS. Exact final seven-file source/test hashes before/after identical in `run-final-b424b76f-0cbd-4735-94e5-6a61a42f9149/verification.json`; earlier lint failure retained separately. This is final-tree proof, not an old manifest equality claim.
- `git diff --check`: PASS tracked changes; new comparator staged check pending coordinator. Public artifacts remain subject to the publication boundary above; local logs/resources are not publication material.

Rollback only the new prescription `readMany` reader and evaluator batching with their coupled regressions/comparator; original read/publish behavior and unrelated P6/probes stay preserved. Candidate review/commit/publication/production validation/deployment remain pending coordinator, not authorized by local performance results.
