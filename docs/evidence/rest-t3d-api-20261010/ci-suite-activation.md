# Isolated OFF profile PostgreSQL suite activation

Criterion: REST-P5-CI-SUITES-01. The final CI correctly rejected an incomplete receipt: four PostgreSQL suites and 142 tests were skipped because its sanitized child environment did not generate the required suite flags.

## Minimal correction

The OFF launcher now prepares its isolated legacy fixture and verifies database identity and observed OFF tracking before generating `FOLLOWUP_HTTP_PG=1` and `FOLLOWUP_SERVICE_PG=1`. Parent flags remain untrusted and excluded from the child allowlist. The ON route and test families are unchanged. Selection, zero-skip, ownership, database and failure guards remain intact.

## Observed verification — 2026-10-10

- RED: all three added regressions failed before implementation. A separate initial worktree discovery check was blocked by absent dependencies; it was not reported as PASS.
- GREEN: exact `node --test scripts/run-adherence-integration.test.cjs` using byte-identical candidate source and private offline dependency copies: 10 tests passed, zero failures/skips. Regressions cover activation after preparation, rejected preparation, OFF-only selection and untrusted parent flags. `node --check scripts/run-adherence-integration.cjs` passed.
- Real PostgreSQL 17.11/bookworm OFF run: a fresh uniquely labelled container, tmpfs-only storage, random loopback port, verified image/role/database/PGDATA/tracking and empty database before writes. Main migrations prepared only after those guards; the affected launcher prepared its own legacy fixture. The harness did not supply either suite flag.
- Exact `node scripts/run-adherence-integration.cjs off` (the package script equivalent) passed in 345.4 seconds: unit 111 suites / 1418 tests, concurrency 24 suites / 390 tests, zero skipped cases. Existing complete-receipt guards admitted both results.
- Source snapshots remained byte-identical during execution. Installed generated-client schema matches the candidate semantically after the previously authorized attribute-order normalization; no client regeneration or original dependency writes.
- Complete paths/modes/blobs inventory permits only this runner, its regression file and this receipt. Schema, migrations, workflow, contracts, locks and product code remain unchanged. Original checkouts and dirty/untracked files are preserved.

## Limits and rollback

The owned disposable container is retained; no shared or previously existing database was targeted and no provider credentials were forwarded. Dependencies were copied offline without env/private-key files or symlinks; no installations. ON, e2e and remote CI for the new commit were NOT_RUN. Fresh exact-head CI is still required before integration; no native approval is transferred or claimed. Rollback is limited to this launcher correction, its regressions and this receipt; it would restore the known incomplete OFF receipt.
