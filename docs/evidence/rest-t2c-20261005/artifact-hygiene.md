# REST-T2C-0 — generated-artifact visibility reduced without loss

2026-10-05. **6742 → 246 visible untracked files**, plus one tracked `.gitignore` modification. Only verified REST-T2B generated cache/build trees are newly ignored. No original evidence/source was edited, moved or deleted; HTTP implementation has not started.

## Exact appended patterns

```gitignore
# REST-T2B: retain receipt logs; hide only verified regenerable artifacts
!/docs/evidence/rest-t2b-20261005/**/*.log
/docs/evidence/rest-t2b-20261005/unit-*/cache/
/docs/evidence/rest-t2b-20261005/pg-*/cache/
/docs/evidence/rest-t2b-20261005/all-*/cache/
/docs/evidence/rest-t2b-20261005/corrected-build/
/docs/evidence/rest-t2b-20261005/independent-build/
/docs/evidence/rest-t2b-20261005/final-independent-build/
```

The narrow log exception makes 23 prior receipt logs visible despite the existing global `*.log` rule. No whole evidence-root rule was added. No future REST-T2C patterns were guessed: the delegated plan did not name exact future generated cache/build paths.

## Before/after and regeneration classification

| Observation | Before | After |
| --- | ---: | ---: |
| API visible untracked files | 6742 | 246 |
| REST-T2B visible untracked files | 6737 | 236 |
| Original source/scripts visible | 5 | 5 |
| New REST-T2C-0 evidence files | 0 | 5 |
| Tracked modifications | 0 | 1 (.gitignore) |
| REST-T2B files physically present | 6760 | 6760 |

New ignored files: **6524** = 3665 files across 15 cache trees + 1150 corrected-build + 871 independent-build + 838 final-independent-build. The arithmetic is 6742 − 6524 + 23 newly visible receipt logs + 5 new hygiene artifacts = 246.

Cache trees contain no snapshot/manifest/test-result/resource receipt files. Build outputs contain only emitted JS/maps, generated declarations or declaration snapshots, and the copied `src/contracts/response-contracts.json`. No authored-source snapshots occur in those output trees: all `.snapshot` files there are compiler-generated `.d.ts.snapshot` artifacts, not sole authored source or required recovery copies. Actual authored source and its historical/final recovery copies remain outside the ignored outputs. The final recovery manifest identifies 11 copies (including the separately appended final coordination snapshot); every one is present, unignored and hash-matched. Ignored generated declaration artifacts remain physically available to their unchanged rename/hash inventories.

## Structural verification (no tests/build)

Read-only commands: `git status --short`, `git rev-parse HEAD`, `git branch --show-current`, `git rev-parse --abbrev-ref '@{upstream}'`, `git ls-files --others --exclude-standard -z`, scoped Python file-count/hash inspections, `git check-ignore --no-index --stdin -z`, named `git check-ignore --no-index [-v] <path>`, `git diff -- .gitignore`, `git diff --check`.

- Bulk check-ignore confirms all **6524/6524** generated files are ignored and still exist.
- Named build representatives: each output's `src/contracts/response-contracts.json` exists and matches only its specific build-directory rule.
- Named cache representatives and run receipts are checked separately: `unit-60499df3-e06e-49f4-9ddd-7a6682e6abdb/`, `pg-2ecfe026-ca6e-4083-8b5a-82e81c1e69f9/`, `all-0f9422f5-8d88-4b11-b5f9-e29be0b8f5fb/`, each under REST-T2B. Existing `cache/haste-map-41ddef070395630d620d108b3390606c-5831c46c4d7517ac41dccc73a8398b83-0fbcb8f5c2f9c30ce768bc5d4f877e5e` matches only its unit/pg/all cache rule. Sibling `jest.json` and `jest.log` are present, nonignored and listed by Git. A bulk nonverbose check-ignore additionally confirms **all 236 non-generated REST-T2B files are unignored**.
- Nonignored representative paths: REST-T2B `README.md`, `final-scoped-receipt.md`, `final-checkpoint/manifest.json`, `final-checkpoint/RECOVERY.md`, `before/src/modules/client-followup-tasks/client-followup-tasks.service.ts.snapshot`, latest full `jest.json` and `jest.log`; all five source/script paths and all 11 final recovery copies. For verbose check-ignore, a printed `!` rule is an unignore match; nonverbose check-ignore and `git ls-files` establish visibility, not verbose exit code alone.
- Before/after content aggregate matches for all **6744 non-env evidence files**: `f8c56f92c0f4f46215669a4136284d781d165f6f10f75229bc7fd75377cce9ad`. Sixteen env-named artifacts were counted but their contents were deliberately not read; no operation targeted them. All five source/script hashes match the existing verified candidate.
- `.gitignore` before SHA256: `0c1d02b52d676a1e528076246ab74e8acac83109eb434f88f988dfdf729374d3`; after: `86a10f21f8a884058193b8d98b30d6759ca73281c97591c31939500d7d6fb356`. Both exact snapshot hashes were verified.
- `git diff --check`: PASS. A read-only inspection attempt initially failed with a Python quoting SyntaxError; the corrected inspection completed without filesystem writes.

[Checkpoint manifest](checkpoint/artifact-hygiene/manifest.json), [before snapshot](checkpoint/artifact-hygiene/gitignore.before.snapshot), [after snapshot](checkpoint/artifact-hygiene/gitignore.after.snapshot), [appended diff](checkpoint/artifact-hygiene/gitignore.patch).

API remains `feat/progreso-adherencia-p4` / `origin/feat/progreso-adherencia-p4`, HEAD `c383d47f4aa8217f727acf33e4c1900c0866b7bd`. Remaining noise is intentional: 236 visible REST-T2B authored receipts/manifests/recovery evidence, five source/scripts and five hygiene files. The ignored outputs are retained, not a disposable-cleanup grant. No tests/builds, source/harness edits, resource operations, staging/commits or remote actions. Passive ignore-only change has no meaningful behavioral RED; structural preservation checks are its validation. Stop at REST-T2C-0; parent owns coordination and any separate HTTP-unit start.

## Current refinement — local run artifacts and checkpoints

2026-10-05, later user authorization. **410 → 19 Git status entries: evidence visibility 399 → 8; all 11 code/config entries remain visible.** This section supersedes the preceding initial visibility policy, not its historical counts/checks. Existing HTTP implementation is now present and untouched; parent independent verification remains pending. No REST-T2C/P5 closure is claimed and no source, harness, tests, build, review or resource operation was performed in this passive refinement.

### Classification and precise appended rules

Maintained Markdown receipts are retained in Git view. Per-run stdout/JSON/results/resource inventories/privacy preload, caches/build output, intermediate before/after source copies and local recovery checkpoints are retained on disk but excluded from Git view. Old .gitignore modifications, including their earlier log exceptions, remain byte-for-byte as the first 1664 bytes; appended rules explicitly supersede those exceptions only within the two named roots.

```gitignore
/docs/evidence/rest-t2b-20261005/unit-*/
/docs/evidence/rest-t2b-20261005/pg-*/
/docs/evidence/rest-t2b-20261005/all-*/
/docs/evidence/rest-t2b-20261005/before/
/docs/evidence/rest-t2b-20261005/after-*/
/docs/evidence/rest-t2b-20261005/final-checkpoint/
/docs/evidence/rest-t2b-20261005/**/*.log
/docs/evidence/rest-t2b-20261005/**/*.json
/docs/evidence/rest-t2b-20261005/**/*.snapshot*
/docs/evidence/rest-t2c-20261005/http-*/
/docs/evidence/rest-t2c-20261005/unit-*/
/docs/evidence/rest-t2c-20261005/pg-*/
/docs/evidence/rest-t2c-20261005/all-*/
/docs/evidence/rest-t2c-20261005/before/
/docs/evidence/rest-t2c-20261005/after-*/
/docs/evidence/rest-t2c-20261005/checkpoint/
/docs/evidence/rest-t2c-20261005/**/*.log
/docs/evidence/rest-t2c-20261005/**/*.json
/docs/evidence/rest-t2c-20261005/**/*.snapshot*
```

No whole-root/global-docs ignore was added. Existing generated-build/cache exclusions remain unchanged. **Ignored checkpoints are LOCAL ONLY**, not recovered by a fresh clone absent a separately preserved archive/delivery. Receipt links to ignored artifacts remain valid local workspace references, not a portability promise. No separate archive delivery is claimed. This is an explicit change in visibility/recovery expectations under the later authorization, not a claim that required source snapshots are regenerable. No historical T2B receipt was edited.

### Preservation and structural checks

| Tree | Disk files before → after | Original payload content check | Visible → visible / ignored after |
| --- | --- | --- | --- |
| REST-T2B | 6760 → 6760 | All 6744 non-env files unchanged; 16 env-named artifacts counted, not read | 236 → 4 / 6756 |
| REST-T2C | 4078 → 4081 | All 4076 original payload files preserved (4068 hashed, 8 env-named counted/not read); only the two maintained README/hygiene docs appended and three new local refinement artifacts added | 163 → 4 / 4077 |

T2B before/after aggregate: `f8c56f92c0f4f46215669a4136284d781d165f6f10f75229bc7fd75377cce9ad`. T2C preserved payload aggregate: `6b3d8a968ca8030de5d3ec895d45fd425868ceeeb9fdc46f2e76bfa38b396e56`, excluding only the two permitted maintained docs and new refinement checkpoint directory. Algorithm: sorted relative POSIX path UTF8, NUL, raw SHA256(content) digest, then SHA256 over the stream. Env contents/secrets were not read. All ten existing task/API registration/script hashes match the pre-refinement inventory; no original file was deleted or moved.

Ignore before SHA256: `3a4ad9db5274316f635809054e7d887ea3bd47dc3b215ff728f135ac8ded5c2b`; after: `744e5fabdf9b6ab18ba98cd0d4d83b7ae15548b8d06c88faa4f5af2f7f6e62a2`. Exact prior bytes are preserved as prefix and as local `checkpoint/artifact-hygiene/refinement-20261005/gitignore.before.snapshot`; appended diff and machine-readable counts/source hashes are in the sibling `gitignore.patch` and `manifest.json`. These links are themselves LOCAL ONLY under the new checkpoint rule.

Observed read-only checks: `git status --porcelain -uall` counts 410 before / 19 after (408 → 17 untracked; two tracked changes remain .gitignore and pre-existing src/app.module.ts). `git check-ignore --no-index --stdin -z` counts all existing ignored paths, without file-content reads; `git check-ignore --no-index -v` confirms actual existing named representatives:

- T2B `all-db49d3c4-8575-4a05-83ca-1b43605ee1f4/jest.json` matches `all-*/`; `final-checkpoint/manifest.json` matches its local checkpoint rule; `independent-verification/corrected-hash-audit.json` matches scoped JSON.
- T2C `http-d8123783-e0e6-4610-ad8c-1ee11f95e390/jest.log` matches `http-*/`; `after-all-6efd7e25-a4a7-45c1-bac5-2d1ff33e72e4/manifest.json` matches `after-*/`; `checkpoint/artifact-hygiene/manifest.json` matches `checkpoint/`.
- Nonverbose check-ignore rejects ignore matches for maintained README/final-scoped-receipt/artifact-hygiene Markdown and all application/task sources/scripts; disk existence is confirmed separately.
- `git diff --check`: PASS. Snapshot prefix, SHA256/source checks and saved incremental diff comparison: PASS. No meaningful behavioral RED applies to this passive policy change.

### What remains visible

Eight evidence files: T2B `README.md`, `final-scoped-receipt.md`, `independent-verification/README.md`, `independent-verification/corrected-candidate.md`; T2C `README.md`, `artifact-hygiene.md`, `http-before.md`, `validation.md`. Eleven code/config entries: existing .gitignore/AppModule changes, seven task TypeScript files (including DTO), and two scripts. All hidden evidence remains physically present. Parent owns pending HTTP verification/disposition; this handoff does not implement, validate or close additional HTTP work.

## Independent-verifier artifact correction — 2026-10-05

Independent technical HTTP/module verification is now PASS; native review/scoped disposition remains pending. This correction only appends artifact exclusions and documentation. It does not rerun tests/build/review or alter application sources, harness, historical receipts or resources.

The independent nondeleting build emitted into `build-independent/`, which the previous exact `build/` exclusion did not cover. Appended exact rule `/docs/evidence/rest-t2c-20261005/build-independent/` hides all 847 existing output files: **846 previously visible generated files remain on disk**, plus one JSON file already excluded by the existing scoped JSON rule. Local independent verifier snapshots/status/patch are excluded by exact `/docs/evidence/rest-t2c-20261005/independent-verification/snapshots/`, `/docs/evidence/rest-t2c-20261005/independent-verification/final-status.txt`, and `/docs/evidence/rest-t2c-20261005/independent-verification/tracked.patch` rules. Existing scoped JSON/log rules already classify audits/logs. The readable `independent-verification/README.md` remains Git-visible; no whole verifier directory is ignored. All these trace artifacts remain LOCAL ONLY unless separately archived/delivered.

**Observed visibility:** 868 → 20 Git status entries (18 untracked + the existing .gitignore/AppModule tracked modifications). Reduction is 846 generated entries plus two local status/patch files. Nine maintained evidence Markdown files and all eleven code/config entries remain visible. Before-ignore SHA256 `744e5fabdf9b6ab18ba98cd0d4d83b7ae15548b8d06c88faa4f5af2f7f6e62a2`; after-ignore SHA256 `a3d96ea641b167c8e877247a70d29f8d3c77a34c478ba3b10656f6f1b67aa4e5`. All prior ignore content is retained, with only four exact rules appended.

### Aggregate-order clarification — historical hashes not replaced

The verifier correctly found that the previously documented ordering was insufficiently precise. Its ordinal relative-POSIX ordering yields `639e76bbc6e2c0559cee94812e4f4843add0d31b05cf6a6c7ed69b3954fa3828`; that recorded aggregate comparison remains FAIL under that interpretation. The writer originally used Python Windows `Path` ordering, which compares case-folded path components. Fresh read-only computation reproduced the historical `f8c56f92c0f4f46215669a4136284d781d165f6f10f75229bc7fd75377cce9ad` using both native Windows ordering and this explicit portable key:

```python
files = [p for p in base.rglob('*') if p.is_file()
         and not (p.name.endswith('.env') or p.name.startswith('.env'))]
ordered = sorted(files, key=lambda p: tuple(
    part.casefold() for part in p.relative_to(base).parts))
digest = hashlib.sha256()
for p in ordered:
    digest.update(p.relative_to(base).as_posix().encode('utf-8'))
    digest.update(b'\x00')
    digest.update(hashlib.sha256(p.read_bytes()).digest())
```

No case-folded component-key collisions were present among these 6744 files. Paths retain original case in the hashed stream; only the ordering key is case-folded. Sixteen env-named files are counted without reading their contents. This corrects the algorithm description, not either immutable historical value or the verifier's earlier finding. The prior T2C aggregate used the same Windows ordering with its documented payload exclusions; no new comprehensive T2C aggregate is claimed after independent runs added artifacts.

Authoritative independent individual preservation evidence remains [local hash-audit.json](independent-verification/hash-audit.json) for current candidate hashes and [local t2b-filelevel-preservation.json](independent-verification/t2b-filelevel-preservation.json): **6722 baseline entries and 37 final artifact entries, zero mismatches**, PASS. This proves individual preservation independently of aggregate ordering; it is not an excuse to relabel the previous aggregate FAIL as PASS.

Structural checks only: `git check-ignore --no-index --stdin -z` confirms 847/847 build files still exist and are ignored; named `git check-ignore --no-index -v` matches only exact build/status/patch or existing scoped JSON rules. Nonverbose check-ignore confirms the readable independent receipt is not ignored. `git status --porcelain -uall` confirms 20 final entries; ten source/script hashes still match the independent audit. `git diff --check` PASS. Native review remains pending; no final REST-T2C or P5 closure is claimed.
