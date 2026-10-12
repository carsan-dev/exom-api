# TSC-LEGACY-03 — bounded identity fixture receipt

> Copia saneada para entrega: ubicaciones normalizadas; resultados, fechas y hashes conservan su significado histórico y corresponden al snapshot privado original, no a esta copia. WORKSPACE_ROOT identifica la coordinación; SDK_ROOT el SDK instalado; RUNTIME_ROOT las herramientas locales; TEST_ARTIFACT_ROOT los recursos privados retenidos, no publicados.


Date: 2026-10-09. Status: SELF-VERIFIED; independent/native/commit pending.
API root: `${WORKSPACE_ROOT}/exom-api`.
Coordination root: `${WORKSPACE_ROOT}/` (unversioned).
Base: `452ff28276ca882313ca5f976579d1bf9dbde860`.
Branch/upstream: `feat/progreso-adherencia-p4` / `origin/feat/progreso-adherencia-p4`.
Artifact root T: `${RUNTIME_ROOT}/AppData/Local/Temp/exom-api-tsc-legacy-20261009-03`.
Commands below run from API root; expand T literally.

## Final change and runtime contract

Only source change from base: `toJSON: () => user.toJSON()` in FakeIdentity's
updated literal. Installed firebase-admin 13.10.0 declares UserRecord.toJSON()
as returning object (`node_modules/firebase-admin/lib/auth/user-record.d.ts:288`).
Class method declarations disappear from inferred object-spread types, although
this fixture's own enumerable arrow method was already copied at runtime.
The forwarding arrow avoids unbound-method lint without suppressions or casts.

Function identity and emitted JavaScript DO change. The wrapper delegates to the
captured original user as receiver, returns its exact serialization result and
propagates its exact thrown error. It does not preserve arbitrary caller-provided
receivers or promise byte/function-identity equivalence. The original fixture
method is `() => ({})`, with no receiver dependency. No test asserts serializer
function identity; IdentityService awaits and ignores update's returned record,
then verifies email/disabled through get. Production files are unchanged.

Final proof: four original fixture result comparisons across unchanged/email/
disabled/both updates; two receiver invocations including a foreign call receiver;
exact returned payload and thrown-error identity, including repeated updates.
Original assertion/case AST texts and all other source bytes unchanged after
removing only the exact added property. Barriers/timeouts unchanged. All20 actual
cases: 15 ordinary plus parameter groups of 2 and 3; no filtering or weakening.
Source SHA256: `34682de251a6b67bec2bacb84e4a177a3ccaae23833deb969f2fbaa28db3310c`.

## Final commands and observed evidence

- `node node_modules/eslint/bin/eslint.js src/modules/identity/identity.concurrency.spec.ts --no-fix`:
  PASS exit0, no warnings/errors; `T/eslint-forwarding.log`.
- `node node_modules/typescript/bin/tsc --project tsconfig.json --noEmit --incremental false --pretty false`:
  expected global FAIL exit2,30 diagnostics. Full comparison PASS:37→30, exactly
  seven identity diagnostics removed, zero added; all remaining full path,
  positions, codes/messages identical. Added property shifts later identity
  positions by one, but no identity diagnostics remain. `T/tsc-forwarding.log`,
  SHA256 `dbe07bacdb40d851a682298694aa8a4820402418eadc1a19b6c2c8fd2a1af42e`;
  `T/tsc-forwarding-comparison.json`, SHA256
  `539716cfcd0d3a63638224f0ed4bee5353af57abafedf18d02b2f96356f4efbe`.
- `node --check T/run-identity-pg-final.cjs`: PASS.
- `node T/run-identity-pg-final.cjs --self-check`: PASS exact20 acceptance, nine
  rejected reports including19/21 counts and three unsafe URL rejections.
- `node T/run-identity-pg-final.cjs`: PASS actual original20/20, one suite,
  zero failures/pending/TODO/runtime-error suites/reported open handles;92
  migrations applied. Fresh final group, no direct-reference group reuse.
  UTC07:40:54.152–07:41:19.876;900s host limit and existing child deadlines.
- `node --check T/proof-forwarding.cjs`: PASS.
- `node T/proof-forwarding.cjs`: PASS results/receiver/errors and preserved
  assertions/cases; `T/proof-forwarding.json`, SHA256
  `6d9201ebc38113ae60537d04cf5a3b12be47ba092878e57deb78f5ae4bb8e355`.
- `git diff --check`: PASS exit0.

RED: authenticated existing37-diagnostic compiler log
`${RUNTIME_ROOT}/AppData/Local/Temp/exom-api-tsc-legacy-20261009-02/independent-tsc.log`,
SHA256 `e6f438a31dda2623154b0340c96c292178f76e5f1b2f04f286c798e2245e4401`;
observed direct-reference lint error→final forwarding lint PASS. Selected typing
cluster GREEN; global FAIL30 is not waived. No artificial business RED.

## Isolation, resource receipt and independent command

Final PG artifacts: `${RUNTIME_ROOT}/AppData/Local/Temp/exom-archive-pg-1Kwv8F`.
Manifest SHA256 `f7cdf0019ad47f8aca590b22c5449160533422e7a80aabe919133eaac94e543b`.
Jest SHA256 `d61b3ca4a8fd5b5353f293abe3a413b58a888c3bb628a0c9d8091bb6e4a75675`.
Owner `archive-1791531654151-e35bde8c874c`; container `exom-` plus owner;
volume container name plus `-data`; exclusive127.0.0.1 port52536, not55493.
Cached PG17 pull-never image, fresh owned volume, owner/image/mount/port checks
and original SQL database/user exom_ci, directory
`/var/lib/postgresql/exom-ci-data`, empty public schema attested before DDL.
Sterile environment, empty dotenv and exact-owned-PG network guard before
migrations; no remote Firebase/provider access. Generated password remains
memory/environment only; logs redacted. File ACL NOT_APPLICABLE (no credential
file); SQL privilege audit not performed/claimed.

Original OWN02 launcher authenticated at
`d71e78f8482aa9dc1f7209c9022369ad2a4304b4d7bacf98785508f55849f87c`, untouched.
Initial OWN03 adaptation changed only target/pin/exact20 count gates. Final copy
`T/run-identity-pg-final.cjs` differs from sealed direct-reference launcher only
by current source pin; guard/provisioning/deadline logic unchanged. Final SHA256
`efe092f8863153c25258be166b8a9e5bca0ff0d789f742f45786330cd6970109`.
Independent command: `node T/run-identity-pg-final.cjs`; verify seal first,
creates another fresh output/resource group. Do not reuse retained groups.

## Historical failures and preservation

Initial enclosing-jest.fn AST comparison failed; `proofs.cjs` and identical
`proofs.failed.cjs` retained. `proofs-corrected.cjs` raw-newline SyntaxError and
`proofs-final.cjs` transformed-printer trailing-comma failure retained unchanged.
Direct-reference runtime proof and PG20 PASS were historical, not final evidence.
Direct-reference no-fix lint failed65:15 unbound-method; subsequent authorized
forwarding repair resolves it. Its source/receipt/launcher/reports/manifest remain
sealed (`T/identity.direct-reference.ts`, `T/receipt.direct-reference.md`,
`T/final-manifest.json` SHA256
`2c8a4eb6c23f66449d89af72529f3acc2d68f876f4f5f3e7dba969b4bde0e84f`).
Earlier partial receipt/manifest retained too. Tool auto-spooled initial output
`${RUNTIME_ROOT}/AppData/Local/Temp/pi-bash-eda4f92fa3f10a19.log`.

Hash-only before/after pins preserve root AGENTS/plan/task, unrun probe, original
launcher/database guard and four foreign caches. Only task pin was refreshed for
parent's earlier authorized tracking correction; no secret/cache contents read.
Guard `a7665cbfd2181eefb6dabca14b495e2f8a3520384a260479bf34d3fe135098bd`;
probe `8b5ba61a1cf147c643727dbfb2f7139126e6f08647906bb7cf5ad9004ddc8ac4`, unrun.
Fresh checkpoint `T/final-forwarding-manifest.json`, patch `T/source-forwarding.patch`.
All resources/artifacts retained; no cleanup/reuse, Git writes/native review,
production actions or publication. Memory deferred to parent as authorized.
Independent verification/native review/commit pending. Global FAIL30/P5 OPEN;
bounded self-verification does not close P5 or claim deployment.
