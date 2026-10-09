# R7 / REST-T2B-FU-04 — versión HTTP ganadora

> Copia saneada para entrega: ubicaciones normalizadas; resultados, fechas y hashes conservan su significado histórico y corresponden al snapshot privado original, no a esta copia. WORKSPACE_ROOT identifica la coordinación; SDK_ROOT el SDK instalado; RUNTIME_ROOT las herramientas locales; TEST_ARTIFACT_ROOT los recursos privados retenidos, no publicados.


Fecha:2026-10-09. Criterio P5-01. Solo una assertion añadida; RED productivo NOT_APPLICABLE (cobertura de comportamiento correcto, no bug ficticio).

Base API728d90626add098427e7e19341e5ad7b15eb4ff4, rama/upstream feat/progreso-adherencia-p4 / origin/feat/progreso-adherencia-p4. SHA256 spec `db81b6bdfd600fa8895a630c812de9d73549b7a48a8cc3f1d9b35f956bbb2b2d`.

La prueba existente fuerza ambos PATCH esperados versión1 a esperar por bloqueo SQL real. Conserva statuses200/409, stored.version=2 y title ganador, y exige además `responseData(winner).version === stored.version`. No mocks de HTTP/guards/locks; perdedor no aplicado.

PASS `node scripts/run-recap-review-persistence.cjs all`: HTTP49/49 y global111 suites/1400 tests,0FAIL/SKIP/pending/openhandles. PG17 propio62718, tmpfs/loopback/imageID/SQL verificados antes de DDL, entorno estéril sin dotenv/red externa. Evidencia final `docs/evidence/rest-t3a-20261005/run-all-38279194-b94c-40db-80f8-3692ad48d060`: jest.json/log y manifests antes/después iguales, resource/sql-preflight. Todos los recursos retenidos. Runf5225b59 tuvo7 fallos ajenos al spec (HTTP49PASS), logs retenidos; no sustituye el all final secuencial PASS.

PASS TSC noEmit/ESLint no-fix dos specs propios/diff-check. Sin producto, rama, permisos o assertions anteriores modificados. Build API no repetido; no nuevo PASS de build. No production/Firebase/JWT, native review/commit/CI/publicación; pendientes del padre.
