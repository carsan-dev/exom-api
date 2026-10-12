# R9 / REST-T2B-FU-05 — deadlock GLOBAL/recálculo

> Copia saneada para entrega: ubicaciones normalizadas; resultados, fechas y hashes conservan su significado histórico y corresponden al snapshot privado original, no a esta copia. WORKSPACE_ROOT identifica la coordinación; SDK_ROOT el SDK instalado; RUNTIME_ROOT las herramientas locales; TEST_ARTIFACT_ROOT los recursos privados retenidos, no publicados.


Fecha: 2026-10-09. Alcance: corrección local del ciclo confirmado en P5; no cierre completo de R9 ni despliegue.

## Candidato y preservación

- Coordinación: `${WORKSPACE_ROOT}/`, sin Git; checkpoint anterior `docs/evidence/p5-pause-20261009/manifest.json`.
- API: `${WORKSPACE_ROOT}/exom-api`; rama `feat/progreso-adherencia-p4`, upstream `origin/feat/progreso-adherencia-p4`, HEAD/base local `728d90626add098427e7e19341e5ad7b15eb4ff4`, sin nuevo commit.
- Servicio antes: `e9818ee67475bdf18e7898c1e55da515d784a87685a642119d84d4fab189abfb`; después: `664ee1a9d4f9a6782c0a8f102bb11ccac1eaf6dcf20a023203930c622ea74cfe`.
- Spec antes: `62a1377fa50537a2640fbc667c0a9df7dcdc79aed87bb2101ec8ef928b1af5db`; después: `42f197f884ad5b3a91b211573f9722016a4aa06e2a7c806a166f87c6a04f96f6`.
- Delta frente al checkpoint: servicio 66 adiciones/11 eliminaciones; spec 299/1. Conservadas las 21 pruebas/assertions/guardas previas.
- Los otros ocho pins del checkpoint siguen iguales: schema, migración, runner, helper/spec de progreso, calculadora de rachas y los dos recibos históricos. Migración `beced1cac41697bcd6e2e1fada5fba397533079f40f1dab9af180724bbba5400` intacta. Admin/App y archivos ajenos no modificados.

## Causa y orden de locks

Antes: `update` escribía `challenges`; el trigger tomaba `challenge_clients`; `syncGlobalAssignments` pedía después el advisory diario. El recálculo hacía diario → assignment: ciclo assignment → diario / diario → assignment, demostrado con `40P01` real.

Ahora `update` obtiene primero el conjunto diario completo y ordenado mediante el helper canónico. Incluye todas las asignaciones del reto editado, las GLOBAL de todos los retos del creador y sus clientes elegibles actuales aunque todavía no tengan asignación. Si el creador es NULL, se conserva exactamente el alcance no filtrado del trigger: todas las asignaciones GLOBAL, sin inventar un creador. No se añade mutex global ni una dependencia.

Después de la espera se revalida acceso/propietario y se vuelve a leer el reto. La actualización/trigger conserva el orden diario → filas del reto/asignaciones. La reconciliación comprueba que todo cliente objetivo o existente pertenece al conjunto ya bloqueado ANTES de reutilizar el helper diario. El listado final que alimenta recálculo/logros recibe la misma comprobación. Ningún camino de esta actualización obtiene un nuevo diario después del trigger.

Una ampliación concurrente observada devuelve HTTP409, señal para repetir la operación con un conjunto fresco, no un cambio de política de elegibilidad. El rollback de la transacción revierte reto, periodos y nuevas asignaciones de este intento; conserva la relación externa concurrente. La prueba confirma después que el retry crea la asignación nueva y mantiene el histórico.

Los otros llamadores de `syncGlobalAssignments` son creación y actualización; creación conserva su contrato. `syncGlobalChallengesForCreatorClient` autónomo y `recalculateAutomaticProgress` autónomo ya toman diario antes de sus filas. `UsersService.updateClientAssignments` toma diario antes de cambiar ACA y sincronizar. Los llamadores con transacción recibida no añaden un diario después de sus filas; se conserva esa responsabilidad de la transacción propietaria y no se refactorizan flujos vecinos. El fixture previo cubre escritura ACA real seguida de recálculo y revocación concurrente de rol; su PASS se conserva. Las pérdidas de rol/ACA siguen cerrando periodos inmediatamente por SQL; no se elimina ni acota el trigger.

## RED → GREEN observado, PostgreSQL17 propio

Runner sin modificaciones: `node scripts/run-client-archive-pg.cjs`. Cada ejecución crea un recurso nuevo, con nonce físico, imagen/montaje propios, puerto loopback aleatorio y comprobación SQL de vacío antes de DDL. Sin credenciales heredadas, dotenv, proveedores ni destino55493. Recursos retenidos, sin limpieza.

| Resultado | Entorno y artefacto retenido | Evidencia |
| --- | --- | --- |
| RED | `${RUNTIME_ROOT}/AppData/Local/Temp/exom-archive-pg-wfuAdl/manifest.json`, puerto52539; `10.log`, `jest.json` | 21 PASS / 4 FAIL, producto original exacto e9818ee y spec final42f197, sin editar fuentes durante ejecución. Caso edited: `40P01 deadlock detected`; peer/creator-null: falta la barrera diaria requerida; expansión: acepta en vez de rollback409. |
| GREEN limpio | `${RUNTIME_ROOT}/AppData/Local/Temp/exom-archive-pg-XWIFB3/manifest.json`, puerto53983; `10.log`, `jest.json` | 25/25 PASS, 0 FAIL/SKIP/TODO/openHandles; fuentes iniciales/finales idénticas al candidato664ee1a9/42f197. |
| GREEN legacy | `${RUNTIME_ROOT}/AppData/Local/Temp/exom-archive-pg-vFmaD1/manifest.json`, puerto54066 | `node scripts/run-client-archive-pg.cjs --legacy-upgrade`: upgrade, rollback/recuperación, conservación, idempotencia y 25/25 PASS; sin omisiones/openHandles. Hash legacy antes/después `9a04c41400b86c1546525dcd053cc0b44be9bd38db5877a9862fd041ce8505d8`. |

Pins SHA256 de manifiestos: RED `2289b848977296a64f7beb989545f0a975730c26d45bbf635b339668f46f2385`; GREEN `d157a317c0ba052068ec43cde575d806139d0492b15033db5fe35c10829c9b46`; legacy `e6eb7931a73c442ca0e907464202c86a4708eaa348d9ae39fbe7570e3fba2f86`. Imagen física PostgreSQL `sha256:f4c66b820c6f974249089d3d16d86a3698eae11e8746eb6644b2271031e91232`. Container GREEN `exom-archive-1791566034611-bd8d7929af88`, ID `3bdc876e3d7c8f0f473b914def32941fe0f07f2e6929bc53f781d0b4f36899fb`; volumen homónimo con sufijo `-data`. Los manifiestos describen los otros recursos propios; ninguno se reutilizó para escribir después de su suite.

Las tres regresiones de locks retienen el diario dentro de una transacción real, esperan prueba `pg_blocking_pids` sobre la consulta advisory del servicio, y solo entonces liberan el recálculo. No depende de un `Promise.all` potencialmente serial. Comprueban histórico de cliente/cliente ajeno y cierre exclusivo del periodo seleccionado. Expansión fuerza una ACA externa entre la toma del conjunto y la escritura real, demuestra rollback409, conservación, retry y rechazo de acceso ajeno.

## Comprobaciones finales

Normalización previa limitada a los dos TS propios: `node node_modules/prettier/bin/prettier.cjs --write src/modules/challenges/challenges.service.ts src/modules/users/client-archive.concurrency.spec.ts`. Sin mutaciones fuente posteriores.

| Comando | Resultado |
| --- | --- |
| `node scripts/run-client-archive-pg.cjs --self-check` | PASS: aceptación +7 informes negativos +3 URLs inseguras rechazadas. |
| `node scripts/run-client-archive-pg.cjs` | PASS25/25, manifiesto XWIFB3. |
| `node scripts/run-client-archive-pg.cjs --legacy-upgrade` | PASS upgrade +25/25, manifiesto vFmaD1. |
| `node node_modules/typescript/bin/tsc --project tsconfig.json --noEmit --incremental false --pretty false` | PASS, exit0. |
| `node node_modules/eslint/bin/eslint.js src/modules/challenges/challenges.service.ts src/modules/users/client-archive.concurrency.spec.ts` | PASS, exit0, sin auto-fix. |
| `npm.cmd test -- --runInBand src/modules/challenges/challenge-progress.spec.ts src/modules/streaks/streak-calculator.service.spec.ts` | PASS16/16, 2 suites, entorno hijo estéril con solo variables de descubrimiento OS/herramientas. |
| `git diff --check` | PASS. |
| Prisma validate | NOT_APPLICABLE para esta unidad: ningún cambio de schema/migración ni nueva premisa SQL. |
| Build/suite global/CI/revisión independiente/nativa | NOT_RUN en esta unidad; corresponden al cierre P5 del coordinador. |

Incidencias conservadas, no confundidas con prueba final: primer runner sandbox3iH0AV no pudo arrancar; retry autorizado elevó únicamente el runner. Primer RED N0F6S7 dio21/24 con40P01 pero hubo edición posterior dentro de la vida del runner: sustituido por RED inmutable wfuAdl, no utilizado como pin final. Primer GREEN5byNAX25/25 fue intermedio. TSC intermedio detectó incompatibilidad JsonValue en un spread de fixture; se corrigió con campos explícitos y TSC final PASS, sin cast/ignore. Un intento de restauración mediante comando demasiado largo fue rechazado antes de crear proceso; restauración realizada por parche exacto y normalizada antes del GREEN final.

## Recuperación y límites

Rollback de ESTA corrección: retirar únicamente el delta servicio/spec frente a las copias del checkpoint y este recibo, conservando los demás cambios FU05 y migración. Esto reintroduce el deadlock; no es una recomendación de entrega. HEAD no identifica por sí solo el candidato sin commit: los hashes fuente y manifiestos anteriores son el checkpoint verificable.

No commits, nativeRDD, GitHub, publicación, proveedores, producción, limpieza ni P6. R9 sigue abierto hasta verificación independiente y criterios restantes. Persistencia Engram atribuida pendiente de identidad del host; sin identidad inventada. Siguiente paso permitido: comprobación independiente del candidato y orquestación guardada del cierre P5 por el coordinador.
