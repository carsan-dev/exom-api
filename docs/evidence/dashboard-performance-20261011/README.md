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
