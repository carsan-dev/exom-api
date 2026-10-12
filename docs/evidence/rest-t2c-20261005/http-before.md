# REST-T2C-1 pre-edit checkpoint

> Copia saneada para entrega: ubicaciones normalizadas; resultados, fechas y hashes conservan su significado histórico y corresponden al snapshot privado original, no a esta copia. WORKSPACE_ROOT identifica la coordinación; SDK_ROOT el SDK instalado; RUNTIME_ROOT las herramientas locales; TEST_ARTIFACT_ROOT los recursos privados retenidos, no publicados.


Observed 2026-10-05T12:38:45Z. Coordination root `${WORKSPACE_ROOT}/` is non-Git (rev-parse exit 128). Applicable API checkout `.../EXOM/exom-api`: branch `feat/progreso-adherencia-p4`, upstream `origin/feat/progreso-adherencia-p4`, HEAD and upstream SHA `c383d47f4aa8217f727acf33e4c1900c0866b7bd`.

Existing status: modified `.gitignore` (T2C-0 hygiene); untracked `docs/evidence/`, deletion probe, integration runner and client-followup-tasks directory. No staging. Admin/App outside implementation scope.

## SHA256 before behavioral edits

| Path | SHA256 |
| --- | --- |
| .gitignore | 86a10f21f8a884058193b8d98b30d6759ca73281c97591c31939500d7d6fb356 |
| src/app.module.ts | c9c8554067f89ca0fb1f1885f2322856db3ff9bc445cd1d9135350a80b1687fc |
| scripts/run-followup-tasks-integration.cjs | fe5268ca50fb78a22fb3fd918bdf3551013241aa871e15fd3d30f49a954f251c |
| scripts/probe-client-deletion-lock-order.cjs | 8b5ba61a1cf147c643727dbfb2f7139126e6f08647906bb7cf5ad9004ddc8ac4 |
| client-followup-tasks.service.ts | a3522bb55c67f372b8dccbae9f8ac26ec875e331e01619933110a28284cd1d67 |
| client-followup-tasks.service.spec.ts | 8a8c05f822e948c51e240ba7e8735a4069175c03457df8da2bd695248437a8e7 |
| client-followup-tasks.pg.spec.ts | 9cd76e4e88c853bd8fa679e6307f30e1378e075ef22eed4ce8778656807f8dd5 |
| ../AGENTS.md | f21dc8259e9ff8b7a02122efd9b1651a4a22859081c6871722b099c8476a38db |
| ../odd/tasks/progress-remaining-phases.md | 1f0438d3c75b171e743fac56ab4d5c5f09a313a9f09e05d17ea25ef245f558f3 |
| ../docs/plans/progreso-clientes-plan.md | 8322fb624e1c0e54c51c071c7e90a1a2bdd957c9c33374274c80afb78eb2db16 |
| T2B final-scoped-receipt.md | dd145eff631423050505eeeec2ea15fd5efc48fa689eb28a56a32754195f5e46 |

Service paths above are relative to `src/modules/client-followup-tasks/`. Original recoverable copies remain in the T2B final checkpoint. TDD mandatory by explicit parent/user instruction; runner `node scripts/run-followup-tasks-integration.cjs http`. First behavior run must boot without the missing module, not fail merely on missing imports.

Route evidence: adherence controller uses `admin/clients/:clientId/...`, Roles ADMIN/SUPER_ADMIN, CurrentUser and PUT updates. New route follows that convention. Existing global guards and strict configureApp validation remain authoritative. No list or shared projection endpoint.
