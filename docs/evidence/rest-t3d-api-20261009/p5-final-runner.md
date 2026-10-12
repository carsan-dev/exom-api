# REST-P5-FINAL — runner retenido y aceptación parcial

> Copia saneada para entrega: ubicaciones normalizadas; resultados, fechas y hashes conservan su significado histórico y corresponden al snapshot privado original, no a esta copia. WORKSPACE_ROOT identifica la coordinación; SDK_ROOT el SDK instalado; RUNTIME_ROOT las herramientas locales; TEST_ARTIFACT_ROOT los recursos privados retenidos, no publicados.


Fecha: 2026-10-09, Europe/Madrid. Estado: **PARTIAL / P5 no cerrado**.
Raíz de coordinación: `${WORKSPACE_ROOT}/`, sin Git.
API: `${WORKSPACE_ROOT}/exom-api`; HEAD `728d90626add098427e7e19341e5ad7b15eb4ff4`, rama `feat/progreso-adherencia-p4`, upstream `origin/feat/progreso-adherencia-p4`.
No commit, publicación, P6, producción, proveedor externo ni aprobación nativa.

## Cambio acotado

Se extiende el runner existente, conservando `unit`, `pg`, `checks` y `all`, con perfiles fijos `concurrency`, `e2e` y `adherence-on`. Reutiliza configuraciones Jest y validadores existentes; no acepta argumentos arbitrarios ni credenciales del entorno padre.

Antes de cualquier DDL resuelve la imagen LOCAL `postgres:17-bookworm`, crea por ese imageID inmutable y comprueba el imageID real, nonce de propietario, nombre/ID, PGDATA, tmpfs sin bind/volume, puerto loopback distinto de55493 e identidad SQL vacía. Verifica PostgreSQL17 y tracking. `pg` conserva DB fresh/upgrade sin migrar; `adherence-on` recibe un cluster distinto ya migrado y las cuatro señales de propiedad exigidas. Los perfiles off mantienen legacy84. Cada ejecución conserva cluster, caché, logs, selección, snapshots y manifests tanto en éxito como en fallo.

Entorno hijo por allowlist; `.env` bloqueado y archivo dotenv vacío propio. HOST loopback y schedulers desactivados. Firebase sin proyecto/credenciales; conexiones Node no-loopback rechazadas antes de conectar. La limpieza de filas sintéticas realizada por los tests solo se autoriza dentro de cada cluster NUEVO propio verificado; no se limpia ni reutiliza ningún recurso anterior.

Dos regresiones del runner con RED→GREEN observado:
- ImageID diferente aceptado por la guarda original: `node scripts/run-recap-review-persistence.test.cjs` devolvió1, `Missing expected exception`; ahora rechaza imageID/digest inválido, propietario, mounts y puerto55493.
- Guarda de las siete suites `all` aplicada por error a `pg`: RED `Got unwanted exception: Required full-suite coverage absent`; se restringe exclusivamente a `all`, manteniendo selección exacta, cero skips y mínimos nativos de concurrency224/e2e19.

Self-check final PASS: aislamiento del entorno, bloqueo efectivo de `.env`/conexión externa, guardas y selección incompleta/minimos rechazados. Directorio retenido `${RUNTIME_ROOT}/AppData/Local/Temp/exom-recap-self-check-KBrThj`.
Docker puede registrar tmpfs solo en HostConfig y dejar Mounts vacío; se comprueban ambos destinos tmpfs y se rechaza cualquier mount persistente. `pg_isready -h127.0.0.1` evita confundir el servidor transitorio de inicialización con el servidor TCP definitivo.

## Ejecuciones y resultados

Base de recibos: `docs/evidence/rest-t3a-20261005/`. Los nombres siguientes identifican directorios NUEVOS, no evidencias históricas reescritas.

| Comando | Resultado | Recibo |
| --- | --- | --- |
| `node scripts/run-recap-review-persistence.cjs all` | FAIL:1334PASS /60FAIL /0SKIP;106 suites PASS/5FAIL | `run-all-7013535a-e97d-486c-9a3d-4a41a3ac0220` |
| `node scripts/run-recap-review-persistence.cjs adherence-on` | FAIL:57PASS /20FAIL /0SKIP;5 suites PASS/1FAIL | `run-adherence-on-de0f47ed-ebb9-4a98-9e63-2b36baa25b4b` |
| `node scripts/run-recap-review-persistence.cjs pg` final | PASS:4/4,1 suite,0 skips; esquema limpio y upgrade recap | `run-pg-69f09ca1-f4c6-4c57-8d40-460e431d0a79` |
| `node scripts/run-recap-review-persistence.cjs checks` | PASS:generate/validate/TSC/lint TS no-fix/diff/Nest build | `run-checks-84107d98-f130-4444-91cd-2d59810904fb` |
| `node --check` sobre ambos scripts; self-check; `git diff --check` | PASS final | Salida observada 2026-10-09 |
| ESLint directo sobre ambos `.cjs --no-fix` | BLOCKED:projectService no incluye scripts CJS; no configuración debilitada | Salida observada 2026-10-09 |
| `node scripts/run-recap-review-persistence.cjs concurrency` / `e2e` | NOT_RUN:padre ordena no repetir el defecto productivo demostrado | Pendiente después de corregirlo |

Los manifests before/after de cada ejecución coinciden dentro de su ejecución y conservan519 paths fuente/test/config/scripts, migraciones y documentos de coordinación. No se incluyen caches ajenas como entrega. Después de `all`/`adherence-on`/`checks` solo cambió el runner y su self-check para corregir la guarda de perfil; `pg` final acredita esos bytes. Los bytes productivos permanecen idénticos. Los fallos anteriores siguen siendo evidencia del producto, NO aprobación integral del runner final; todas las suites obligatorias deberán repetirse sobre el candidato corregido final.

El perfil checks ejecutó realmente `prisma generate`, `prisma validate`, `tsc -p tsconfig.build.json --incremental false` con salida aislada, ESLint `{src,apps,libs,test}/**/*.ts --no-fix`, `git diff --check` y `npm run build` (`nest build`). No auto-fix ni formateo masivo; se conserva el estilo CJS existente. Build/TSC/lint no cubren los scripts CJS; estos tienen syntax/self-check/PG propios.

## Bloqueantes comprobados

**56 fallos directos SQL22004**: `record_day_challenge_activity` en `prisma/migrations/20261009190000_p5fu05_global_challenge_eligibility_periods/migration.sql:40` ejecuta `FOREACH meal IN ARRAY NEW.meals_completed`. Los inserts válidos de DayProgress que omiten ese array producen NULL y fallan con `FOREACH expression must not be null`.

| Suite fallida de `all` | Fallos | Ejemplo/referencia |
| --- | --- | --- |
| `training-progress-read.concurrency.spec.ts` |39| `bounds a filtered page with 1000 named historical exercises`, create en157 |
| `progress.concurrency.spec.ts` |4| `P3: old client without session ID or RPE retains one legacy occurrence and historical note`, create en916 |
| `rir-cycle.concurrency.spec.ts` |7| `ISSUE-075: rir_cycle_versions UPDATE rejects protected history with its intended SQL error`, create en142 |
| `legacy-assignment-backfill.concurrency.spec.ts` |5| `preserves monthly video obligations when canonical assignment already exists=true`, fixture en60 |
| `jobs.concurrency.spec.ts` |5| un SQL22004 y los cuatro casos siguientes |

Otros cuatro fallos de jobs, causalidad aún NO atribuida al trigger y sin excepción de base:
1. `P6-01: global concurrency is four across two instances`: timeout5000ms.
2. `P6-02/03: approval rollback has no event and unconfirmed execution never announces success`: expected0/received1 en714.
3. `P6-03/ISSUE-061: a confirmation racing the last failed attempt remains recoverable`: expected `approval_approved`/received `streak`.
4. `P6-04: a fresh consumer recovers aggregates after producer crash, with idempotent effects`: expected23/received24 en1181.

Nombres exactos de TODOS los casos, trazas y resultados: `run-all-7013535a-e97d-486c-9a3d-4a41a3ac0220/jest.json` y `jest.log`. No se modifica ni exceptúa ninguna de estas pruebas.

Las siete suites requeridas específicas sí ejecutaron todas sus assertions: baseline9, assignment-journal13, catalog-journal19, resolver7, followup-list36, followup-http49 y followup-pg12. Esto NO convierte el global en PASS.

**Adherence-on**: los20 casos de `test/adherence-history-cut.pg-spec.ts` fallan en beforeAll181 por la allowlist exacta `migrations.slice(88)`: espera solo las tres migraciones adherence y recibe además `20261005210000_add_weekly_recap_review_drafts_and_publication` y `20261009190000_p5fu05_global_challenge_eligibility_periods`. No se alteró la lista ni las assertions. `jest.json`/`jest.log` del recibo preservan el diff exacto. Cinco suites restantes PASS57/57.

Siguiente superficie mínima propuesta, NO editada: migración existente para tratar NULL como array vacío; regresión de insert/update NULL en `src/modules/users/client-archive.concurrency.spec.ts`; compatibilidad del inventario en `test/adherence-history-cut.pg-spec.ts` añadiendo expresamente las dos migraciones a la allowlist, sin retirar orden, frontera87 ni checksum/restore/provenance. Investigar los cuatro fallos jobs independientemente antes de cualquier excepción; no implementar P6.

## Recursos retenidos y recuperación

Imagen real de todas las ejecuciones elevadas: `sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0`; PostgreSQL `170011`. Ninguna URL/contraseña utilizable se conserva en los manifests. Escaneo de logs/json del global:0 coincidencias de URL con credencial exom_ci.

| Contexto | Container ID | Puerto/tracking | Prueba |
| --- | --- | --- | --- |
| all | `31195943bd38f721135ab2f1bbeea69619589f16433a6721aca3b149d3b57d30` |61150/off| `resource.json`, `sql-preflight.json`, `migrations.json`, `retained-databases.json` |
| adherence-on | `96251d1ec4c24ba14de9bcc4b08a44e3b8bc8551b1782eed989717a3c23f4ceb` |56575/on| `resource.json`, `sql-preflight.json`, `migrations.json` |
| pg final | `fe8c7c28fb7237cde31545b0d618010dd9750bde1917d103f8daf75c399d57e7` |55844/on| `resource.json`, `sql-preflight.json`, `retained-databases.json` |
| pg anterior, guarda rechazada tras Jest4/4 | `1eb7fc3a8ac067b277c6d047ba1302e0e9435aa6a8d60f2de0ab3eedf05bdbc6` |58450/on| `run-pg-a596f60a-fc8a-43c3-8dc8-964ab1475290` |

También retenidos: intento con readiness transitorio `a56d0ad9e74803609e6b4d2d1467644fb2d135d2b9b2bd455549fb2e135dd0b5` (`run-all-a455a2f3-4c8d-41cb-b570-7eb6007d0d6b`, sin DDL de aplicación); intento con guarda tmpfs rechazada `87c19811b71d`, nombre `exom-rest-t3a-0db2d321-4a63-494c-8770-6d6012968e29` (`run-all-9f4f9333-e704-4812-aa72-fd3b29d9a971`, metadatos recuperados read-only por fecha19:28:04CEST, no identidad SQL aceptada ni DDL). Primer intento sandbox `run-all-fb6c56af-3ae7-48e7-9350-20c022f22004` no pudo inspeccionar Docker; no fallback ni contenedor creado. No recursos eliminados/adoptados ni procesos de verificación activos al cierre.

## Pins finales y límite de rollback

Runner SHA256 `2d768c0dbe788964f55d11c60b8dde3d9001fc211b337cd540a1afb0e5c4b8e0`; self-check `74e25c1157067e4de4a2289edb05f87b56d336238a94573f1dd3087d086502f5`. Diff propio runner79adiciones/30borrados; self-check45líneas nuevas; recibo separado. No cambios de producto:

- challenges.service.ts: `664ee1a9d4f9a6782c0a8f102bb11ccac1eaf6dcf20a023203930c622ea74cfe`.
- client-archive.concurrency.spec.ts: `42f197f884ad5b3a91b211573f9722016a4aa06e2a7c806a166f87c6a04f96f6`.
- schema.prisma: `7e4cd4adad18cb812ab8e19c594435c1ab5a6b7b421bdbaa767b4ca4a5401146`.
- migración eligibility: `beced1cac41697bcd6e2e1fada5fba397533079f40f1dab9af180724bbba5400`.
- challenge-progress.ts: `934946d5f3c0cfebb4d15cccdd96294024194c7013e8bbe554ead6fcc2fbb8ba`.
- challenge-progress.spec.ts: `5ef2b2e1659dee02334c8ae0e4b9e946b1399c9862af65aec1ed5123a1ce53ca`.
- streak-calculator.service.ts: `0bdacb3a059a7ce8ea8a586f7c3e8f6654183cb8b7f9513cfe30fed02386b887`.
- run-client-archive-pg.cjs: `cce84a338a6ed77f0bffec5e60a467428d71d67d793adc2cd7ecc4a46d18ff80`.

Rollback solo de esta unidad: retirar el diff de `scripts/run-recap-review-persistence.cjs`, su self-check nuevo y este recibo sin tocar producto, migración, tracker, trabajo ajeno ni recursos retenidos. Las snapshots conservan los bytes ejecutados anteriores. Engram pendiente: runtime sin identidad autorizada; sin creación ni reintento de sesión.
