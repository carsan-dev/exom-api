# Reject incomplete benchmark provenance

Issue 37 is fixed locally: the comparator requires each fixture descriptor hash and all three pinned harness manifest hashes to be 64 hexadecimal characters before equality. Equal missing or malformed values are no longer evidence of matching provenance. This changes only offline benchmark verification, not Dashboard responses or performance.

## Verification — 2026-10-11

Base: `4600f7f91e79db87066a376207941c4289b09928`. Node 22.21.0, local files only; no network, database or benchmark execution.

|Check|Observed result|
|---|---|
|`node --test docs/evidence/dashboard-performance-20261011/test.cjs` before fix|RED: five existing tests PASS, two new provenance tests FAIL; wrong equality/payload errors demonstrate absent validation|
|Same command after fix|GREEN: 8/8 PASS; 36 invalid CLI subprocess cases plus one valid CLI case|
|`node --check docs/evidence/dashboard-performance-20261011/compare.cjs`|PASS|
|`node --check docs/evidence/dashboard-performance-20261011/test.cjs`|PASS|
|`git diff --check`|PASS|

Each required key is tested missing on either or both inputs. Matching malformed values cover empty string, null, number, object, wrong length and nonhex characters. CLI failures must identify required SHA256 provenance before payload comparison and must not create comparison output. Existing five assertions remain intact. Temporary fixtures are owned unique directories and removed in `finally`.

## Retained artifacts remain unchanged

Pairs under `docs/evidence/dashboard-performance-20261011/`:

- 30 days: `run-30-2417eaa7-0fd6-4280-a123-e741ef1017ee` → `run-30-80ca9813-55d4-4fb6-863f-effac1379de0`.
- 1825 days: `run-1825-1b2f2957-f813-4032-b3f2-58d79b00f23d` → `run-1825-542783a7-1546-459d-8ed2-88673472388d`.

The existing CLI is `node docs/evidence/dashboard-performance-20261011/compare.cjs <before-directory> <after-directory>` and writes `comparison.json`; it was not run against originals. An owned 30-day copy created with `fs.cpSync(..., {preserveTimestamps:true})` failed with exit 1, `Capture outside owned measurement window`: copying preserves mtime but not original resource birthtime. This is a retained-copy limitation, not a comparator PASS. No new CLI mode or weakened window check was added.

Authorized fallback used the existing exported `compare` on original responses with original resource birthtime/measurement mtime windows. Both pairs PASS: canonical eleven endpoint hashes, eight raw equal hashes, exactly 202 verified volatile leaves and eleven equal payload byte lengths. SHA256 of all 18 existing measurement/manifest/fixture/resource/comparison files remained identical before/after. Valid CLI execution is separately proved by the complete owned synthetic regression.

Production lint/build, API unit, PostgreSQL and concurrency suites: **NOT_APPLICABLE**; no production, TypeScript, schema, authorization, transaction or API contract changes. No deployment, migrations or real-data operations performed.

## Review and rollback

Review the shared hash guard, then subprocess regressions. Revert comparator/test changes and this coupled receipt to roll back this unit; preserve original benchmark evidence. Local feature commit and parent-owned native review precede any delivery decision. Issue closure remains pending; no remote operation is authorized in this unit.
