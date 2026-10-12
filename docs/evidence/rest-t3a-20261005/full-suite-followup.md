# REST-T3A — full-suite launcher follow-up

2026-10-05; same API branch/base `feat/progreso-adherencia-p4` / `224e7b0051ff0f96821ebd95aad0a171106bc683`. Parent authorized only runner/evidence edits. Schema, migration, service, both test files and ignore rules are unchanged from the scoped candidate. No application fix, test/assertion change, disabled test, dependency change, native review or Git mutation.

## Diagnosis and retained failures

Independent sanitized `npm test -- --runInBand` without a DB remains **FAIL**: 83 passed suites, 4 failed suites, 22 skipped suites; 864 PASS, 48 FAIL, 406 SKIP (1318 total). Original log: [full-suite.log](run-checks-0ce50da4-4607-438f-a32b-366973002ee7/full-suite.log). This was not proof of an application defect:

- Assignment-journal, catalog-journal and commit-resolver concurrency suites require a guarded `TEST_DATABASE_URL`; they are not optional DB tests. Their beforeAll rejects the absent URL; some afterEach errors follow missing initialization.
- History-baseline requires the exact launcher nonce/legacy84 database, matching TEST/DATABASE/PRISMA/DIRECT aliases and PostgreSQL commit tracking OFF.
- Optional database and follow-up suites were skipped because the isolated launch flags/resources were absent.

Inspected the retained `run-followup-tasks-integration.cjs` all protocol and `test-database.cjs`, plus actual test guards. Added bounded `all` mode to the recap runner, using the existing package Jest configuration unchanged, a fresh owned PostgreSQL container, 92 current migrations and a separate owned legacy84 template. All DB aliases identify the owned main database; `FOLLOWUP_SERVICE_PG=1`, `FOLLOWUP_HTTP_PG=1`, `EXOM_RESOLVER_TRACKING=off` and existing history ownership variables are supplied explicitly. No incoming DB configuration is inherited.

First new `all` execution remains **FAIL**: [run-all-766c4dcd-f7f1-4a57-8564-a08ce495bfc7/jest.log](run-all-766c4dcd-f7f1-4a57-8564-a08ce495bfc7/jest.log), 105 PASS / 4 FAIL suites, 1221 PASS / 108 FAIL tests, zero skipped. All four originally failing adherence suites passed. The runner omitted the retained launcher's `DATABASE_SSL_MODE=disable`; `databasePoolConfig` defaults to verified TLS, while the owned Docker server does not provide TLS. Follow-up Prisma services therefore failed DB startup. Restored the same test-only SSL setting in the allowlisted child environment; production TLS policy was not edited or weakened.

## Required commands and final evidence

| Exact command | Observed result |
| --- | --- |
| `node scripts/run-recap-review-persistence.cjs all` | First run FAIL as above; corrected final run **PASS: 109 suites / 1329 tests, zero skipped/pending**. |
| `node scripts/run-recap-review-persistence.cjs checks` | **PASS**: Prisma generate/validate, isolated nondeleting tsc, lint without fixes (0 errors / 2 existing progress-concurrency warnings), diff check. |

Final full-suite log/report: [run-all-81cdc99e-1435-442e-89a9-89193f41a95e/jest.log](run-all-81cdc99e-1435-442e-89a9-89193f41a95e/jest.log), `jest.json` and exact `jest-command.json` beside it. The runner requires successful nonempty execution of all four formerly failing adherence suites and follow-up HTTP/list/PG suites, and rejects any pending tests. Current count is prior 1325 plus four populated-review unit regressions. Full src Jest does not include the separate test-directory recap migration suite; its unchanged 4-PG-test scoped verification remains separate, not claimed as part of 1329.

Final checks: [run-checks-0ec1cb5d-40fb-4db0-8ec6-68dae817944a/manifest.json](run-checks-0ec1cb5d-40fb-4db0-8ec6-68dae817944a/manifest.json), with child command receipts, logs, source `.snapshot` copies and all 92 migration hashes. Runner SHA256 `e7c17cd60971fc831c2091b63d6006ba3092ec9391a7ad94f9a45fb90d0c2937`. Other six authored source/config hashes and the original deletion-probe hash match the prior scoped checkpoint. The all/checks manifests identify the same runner bytes.

## Isolation and preservation

Final full-suite resource: container `exom-rest-t3a-048ef07e-7684-4e81-a8fa-8f7d180f8978`, full ID `a6dc26b54ebeff3fc4f4abc6eeebdc62d5dacaa8785e34e5a074f6efc2652190`; `127.0.0.1:51098`, role `exom_ci`, PGDATA `/var/lib/postgresql/exom-ci-data`; main database `exom_ci` and template `exom_ci_history_legacy_7f814563`. Container ownership label/name/full ID, loopback binding, running state, tmpfs-only mounts and SQL database/role/data-directory/empty-schema identity were verified before writes. Same checks were repeated afterward. The final [retained-databases.json](run-all-81cdc99e-1435-442e-89a9-89193f41a95e/retained-databases.json) inventories suite-created synthetic clones. Both new run instances and all prior resources/evidence remain retained. Runner executes no cleanup/drop/truncate/revoke/reset/shutdown; existing tests retain their authorized synthetic fixture lifecycle, unchanged. No production dotenv or credential fallback; Docker inspect credentials remain in memory only.

This closes only the launcher/full-suite validation follow-up. Pre-existing client mutation `admin_comments` exposure is separately tracked as REST-T3-PRIVACY-01 for parent disposition, not fixed here. No REST-T3/P5 completion, remote migration, deployment or live client-system validation is claimed.
