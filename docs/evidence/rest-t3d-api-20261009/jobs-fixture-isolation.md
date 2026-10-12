# P5 — aislamiento de fixtures jobs

> Copia saneada para entrega: ubicaciones normalizadas; resultados, fechas y hashes conservan su significado histórico y corresponden al snapshot privado original, no a esta copia. WORKSPACE_ROOT identifica la coordinación; SDK_ROOT el SDK instalado; RUNTIME_ROOT las herramientas locales; TEST_ARTIFACT_ROOT los recursos privados retenidos, no publicados.


Estado: COMPLETE para esta corrección de tests de REST-P5-FINAL; no cierre P5, aprobación nativa ni despliegue.
Fecha: 2026-10-09, Europe/Madrid. `skill_resolution: paths-injected` (ponytail, typescript, work-unit-commits).

## Alcance e identidad

Coordinación `${WORKSPACE_ROOT}/`, sin Git. API `${WORKSPACE_ROOT}/exom-api`, HEAD `728d90626add098427e7e19341e5ad7b15eb4ff4`, rama `feat/progreso-adherencia-p4`, upstream `origin/feat/progreso-adherencia-p4`. Estado previo y posterior conservan FU05, runners, regresiones NULL/allowlist y archivos ajenos. Superficies propias: `src/modules/jobs/jobs.concurrency.spec.ts` y este recibo; no producto, modelo, migración, proveedor, GitHub ni commits. Plan y seguimiento leídos, sin editar; P5-04 continúa diferido a P6, no es condición prospectiva de cierre P5.

CodeGraph se consultó antes de inspeccionar el flujo. Primer comando `codegraph explore JobsService --depth 1` rechazó la opción; `codegraph explore JobsService` funcionó. Inspección: fábrica de tests registra FCM; `JobsService.runSlot` filtra tipos registrados, ordena por fecha/key y consume una sola unidad por slot/tick. No se cambia ese algoritmo.

## Causas confirmadas y corrección mínima

1. Limpieza incompleta de notificaciones: `beforeEach` borraba solo sender propio. El milestone usa el SUPER_ADMIN activo más antiguo, que ahora puede pertenecer al fixture archive retenido, y deja una notificación `streak` al recipient de esta suite. Contamina las tres assertions posteriores (count0/1, tipo approval/streak, count2/3). La limpieza ahora elimina únicamente sender **o recipient** del owner sintético único de esta suite, dentro del cluster nuevo propio ya identificado. No borra notificaciones ajenas a ese owner ni restaura el borrado de histórico archive; sender y lógica productivos intactos.
2. El timeout no era un fallo del límite global: nueve FCM antiguos elegibles precedían a los ocho TEST propios. Dos drains consumen cuatro slots globales y solo una unidad por slot. Metadatos reales del diagnóstico muestran exactamente cuatro FCM `PENDING/attempts0` → `FAILED/attempts1`; los ocho TEST siguen `PENDING/attempts0`, ambos drains terminaron, maximum/active0, sin locks restantes ni espera en pools. Todos los TEST eran due según el reloj PostgreSQL. Se construyen dos JobsService frescos mediante su constructor público y se registra solo TEST en este caso; sin spies, vaciado de registro privado, mocks de claim, cambios de prioridades/reloj, borrado de FCM ni cambio productivo.

El caso mantiene entered4/max4 y ocho entradas; añade ocho DONE tras otro tick acotado y snapshot igual de TODOS los campos operativos FCM antes/después. Conserva todas las assertions previas. Preflight SQL exige ocho PENDING/due con el mismo predicado temporal de producción. Entrada compite contra la finalización de ambos drains y deadline2500ms, sin elevar timeout Jest5000ms. Ante fallo imprime solo estado de trabajos propios, slots y contadores de pools; `finally` cancela timer, libera gate y espera ambos drains con allSettled, sin dejar handlers/leases bloqueados. Los diagnósticos de cola no incluyen payload, credenciales ni identificadores ajenos.

## RED observado y diagnósticos retenidos

Todos los directorios siguientes pertenecen a `docs/evidence/rest-t3a-20261005/`; `jest.json`, `jest.log`, manifests y recursos conservados.

| Comando | Resultado real | Directorio |
| --- | --- | --- |
| `node scripts/run-recap-review-persistence.cjs concurrency` previo, recibido y releído | 373 PASS / 4 FAIL / 0 SKIP | `run-concurrency-35197b59-6a59-4dfd-94d9-e0f6a9e625ba` |
| Mismo comando, limpieza + primer preflight diagnóstico | 376 PASS / 1 FAIL / 0 SKIP; preflight reloj host vio7, no prueba de causa productiva | `run-concurrency-abee6e74-9fd1-4cd9-a724-a0b97b5ee2be` |
| Mismo comando, reloj SQL | 376 PASS / 1 FAIL / 0 SKIP; ocho due, ambos drains terminan sin reclamar TEST | `run-concurrency-5e5e4f42-c14a-43e6-ac81-31299d05a34e` |
| Mismo comando, cola antes/después | 376 PASS / 1 FAIL / 0 SKIP; nueve FCM delante, cuatro consumidos, ocho TEST intactos | `run-concurrency-d59841a8-c4fb-4a9a-9f6a-89e6d5080375` |

El primer intento sandbox `run-concurrency-7cd5f9b0-97b0-4cf5-a351-a252bf5b9491` falló antes de DDL/suite al consultar imagen Docker; no RED causal. Reintentos usaron escalación aprobada, no fallback de imagen/DB. El lint inicial diagnóstico falló cinco reglas de formato; se registra sin presentarlo como PASS. TSC inicial exit0.

## Candidato final y GREEN

Normalización única del spec antes de verificar/fijar: `node node_modules/prettier/bin/prettier.cjs --write src/modules/jobs/jobs.concurrency.spec.ts`. Luego, sin nuevas escrituras fuente:

| Comando exacto | Resultado |
| --- | --- |
| `node node_modules/typescript/bin/tsc --project tsconfig.json --noEmit --incremental false --pretty false` | PASS exit0 |
| `node node_modules/eslint/bin/eslint.js src/modules/jobs/jobs.concurrency.spec.ts --no-fix` | PASS exit0 |
| `git diff --check` | PASS exit0, repetido tras perfiles |
| `node scripts/run-recap-review-persistence.cjs concurrency` | PASS377/377,24 suites,0 FAIL/0 SKIP/0 open handles; `run-concurrency-1867c2bc-70f3-4503-a94f-52a93c01b7b1` |
| `node scripts/run-recap-review-persistence.cjs all` | PASS1396/1396,111 suites,0 FAIL/0 SKIP/0 open handles; `run-all-9c06b3bd-c47b-49bd-a83b-e60a5cf0a516` |

Ambos perfiles exit0, selección y mínimos existentes intactos. Antes/después de cada perfil: cero diferencias de hashes fuente; la comparación contra el manifest del concurrency previo identifica únicamente el spec jobs como fuente cambiada. Los perfiles finales comparten los mismos bytes. El spec pasa de `1a40b89c74ca91c9ca188c5356c84f129605c3464a1e9235dd9323b955d8e4bc` a `ebb9e129786157d87f3095d6aa3caba0ead5f440e15660bcc41e79aa5690f5a9`.

Pins productivos intactos: JobsService `795031deca85530f943765386da1c66ed1fb2d05d170021617ee8cbf1e925925`; DomainWorkService `ae367b70293d7c31582c6aac8d9c83e9143bd9a19eabed098f8d5a804fcd09b3`; NotificationsService `ac2415c3f5b9566d0054356181d2d810f1db17433d201677e55881de7c1491ff`; ChallengesService `664ee1a9d4f9a6782c0a8f102bb11ccac1eaf6dcf20a023203930c622ea74cfe`; schema `7e4cd4adad18cb812ab8e19c594435c1ab5a6b7b421bdbaa767b4ca4a5401146`; runner `2d768c0dbe788964f55d11c60b8dde3d9001fc211b337cd540a1afb0e5c4b8e0`. Manifests conservan inventario completo y snapshots, no solo HEAD.

| Perfil final | Puerto | Container ID |
| --- | --- | --- |
| concurrency |55436| `44b9809be0419d1f5d0d05269995ddc3301d862f3ab0d8635abb5440f3871f68` |
| all |57906| `a9e377dd04f362009730b85c87c02f502311449a174da3fc28fd5dbd78d7679b` |

Imagen física PostgreSQL17 en ambos `sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0`, PG170011, tracking off, rol sintético exom_ci, tmpfs propio, loopback y PGDATA físico identificado antes de escribir; `sql-preflight.json` confirma cero tablas públicas antes de DDL. `resource.json`, `migrations.json`, `retained-databases.json`, selección y manifests contienen prueba no secreta reproducible. Recursos anteriores/nuevos retenidos, sin eliminar contenedores/volúmenes/logs/cache/usuarios históricos externos. Limpieza ordinaria de filas sintéticas solo en el nuevo recurso verificado propio.

## Aplicabilidad, recuperación y límites

El recibo anterior `p5-null-activity-and-history-cut.md` permanece inmutable SHA256 `28c952be5455fb7378fa4b2aa18832efdd8f2c5351b8e551f3bd7c6cec4c3f78`: archive limpio/legacy27/27, adherence-on77/77, e2e46/46, recapPG4/4 y build/lint global allí son evidencia histórica aplicable a los mismos bytes productivos, NO nuevas ejecuciones. No se repitieron esos perfiles ni build/lint global por un cambio exclusivamente de fixture. El TSC completo sí se ejecutó sobre el spec final. No se debilitaron validadores, guards, skip gates o assertions para cerrar.

Rollback de esta unidad: retirar solo el diff del spec jobs y este recibo; no revertir FU05, runners, conservación de fixtures archive ni evidencia histórica. No commits, revisión nativa, CI, publicación ni P5 DONE; decisiones siguientes corresponden al padre. Admin/App no se editaron ni revalidaron. Engram sigue pendiente: raíz ambigua y sin identidad registrada; no sesión inventada ni escritura atribuida.
