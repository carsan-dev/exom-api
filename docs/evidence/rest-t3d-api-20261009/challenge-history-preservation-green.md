# FU05 — conservación de retos GLOBAL y elegibilidad

> Copia saneada para entrega: ubicaciones normalizadas; resultados, fechas y hashes conservan su significado histórico y corresponden al snapshot privado original, no a esta copia. WORKSPACE_ROOT identifica la coordinación; SDK_ROOT el SDK instalado; RUNTIME_ROOT las herramientas locales; TEST_ARTIFACT_ROOT los recursos privados retenidos, no publicados.


Fecha: 2026-10-09. Estado del escritor: **PARTIAL**; aceptación FU05 focalizada GREEN, cierre global P5 pendiente de comprobaciones independientes. API base `728d90626add098427e7e19341e5ad7b15eb4ff4`, rama `feat/progreso-adherencia-p4`. Sin commits, publicación, migración remota, datos reales ni limpieza de recursos. Admin/App y documentación de coordinación no modificados.

## Resultado e invariantes

Se mantienen identidad, valor, fechas de asignación/completado y estado histórico de ChallengeClient GLOBAL cuando sale del ámbito del creador. Los periodos cierran la elegibilidad sin eliminar la fila. La reentrada comienza el siguiente día UTC. El baseline conserva lo ya alcanzado; el undo de actividad elegible del periodo abierto sigue reduciendo su contribución. TRAINING_DAYS, MEAL_CHECKINS y WEIGHT_LOGS suman baseline y contribución elegible; STREAK_DAYS conserva la semántica consecutiva canónica y aplica el máximo entre baseline y racha abierta, no suma rachas independientes.

La fecha de actividad y su procedencia deben pertenecer al mismo periodo; las escrituras inactivas retrofechadas no generan crédito al reentrar. Los triggers conservan procedencia por entrenamiento, ejercicio y comida y por cambio real de peso/fecha, sin reatribuir comidas arrastradas ni notas. Los campos privados @ignore y relaciones internas no aparecen en las respuestas comprobadas de Prisma ni en findMyChallenges.

Las cuatro reglas se comprobaron con ChallengesService real, Prisma/PostgreSQL real y triggers de ámbito/rol/globalidad. El fixture adelanta explícitamente solo el inicio del periodo propio para simular el transcurso del día, sin cambiar el reloj productivo ni inventar procedencia legacy. La reentrada real se comprueba primero como next-UTC-day. Se probaron undo activo, notas/comidas arrastradas, rol de creador/cliente, globalidad, repetición intradía, un único periodo abierto y exclusión de solapamientos. Las pruebas históricas existentes verifican otros clientes, retos compartidos y payload protegido sin cambios.

## RED → GREEN adicional

- Deadlock causal confirmado: scope UPDATE de ACA → trigger bloquea ChallengeClient → recalculador intenta users FOR SHARE; role UPDATE concurrente mantiene users → trigger espera ChallengeClient. RED: 19 PASS / 1 FAIL, P2034, interleaving forzado y pg_blocking_pids positivo. Recurso retenido: `${RUNTIME_ROOT}/AppData/Local/Temp/exom-archive-pg-SLKZl6/manifest.json`, log `10.log`.
- Snapshot obsoleto confirmado: sincronización reabría elegibilidad después de revocación real del rol del creador. RED: 20 PASS / 1 FAIL, un periodo abierto cuando se esperaba cero. Recurso retenido: `${RUNTIME_ROOT}/AppData/Local/Temp/exom-archive-pg-ZGd1dn/manifest.json`, log `10.log`.
- Backfill legacy confirmado: una asignación GLOBAL a un no-CLIENT con creador nulo obtenía elegibilidad. RED: rollback/payload protegido PASS, backfill FAIL. Recurso retenido: `${RUNTIME_ROOT}/AppData/Local/Temp/exom-archive-pg-62vTwB/manifest.json`. Se añade el filtro universal CLIENT, sin modificar datos protegidos.
- El primer fallo de fixture STREAK_DAYS por asOf futuro se corrigió como fixture; **no se presenta como RED productivo**.

## Orden de locks y linearización

Los triggers de ACA, rol y globalidad ordenan ChallengeClient por client_id/id después de escribir su fila de ámbito. El recalculador bloquea las filas GLOBAL del cliente por id, sin bloquear después users/ACA. La sincronización bloquea GLOBAL por client_id/id y vuelve a leer ámbito, periodos y baseline antes de escribir. Así, una mutación de ámbito aún no comprometida puede esperar el ChallengeClient; la lectura MVCC anterior permite que el recálculo se ordene antes de su cierre, y el trigger posterior conserva su resultado antes de pausar. Si el trigger obtiene primero el lock, la lectura nueva excluye el ámbito revocado. No se retiran rechecks de autorización ni locks canónicos de otros módulos.

Las filas recién insertadas no son visibles ni acreditadas antes de commit; la sincronización relee las filas visibles y la elegibilidad actual bajo el mismo orden. Para varios retos del cliente el lock ordenado cubre todas sus filas GLOBAL, no solamente el reto recalculado. Los periodos se releen después del lock, evitando utilizar una apertura/baseline capturados antes de la revocación. La prueba de deadlock observa el bloqueo real del role writer antes de permitir el segundo tramo de la transacción de ámbito.

## Comprobaciones finales

Normalización únicamente de los TS propios con Prettier antes de las comprobaciones finales; sin autofix global. Todos los checks siguientes corresponden a los hashes de fuente inferiores.

| Comando | Resultado |
| --- | --- |
| npm.cmd run prisma:generate | PASS, Prisma 7.10.0 |
| npm.cmd exec -- prisma validate | PASS |
| node node_modules/typescript/bin/tsc --project tsconfig.json --noEmit --incremental false --pretty false | PASS |
| ESLint no-fix focalizado | PASS cubierto también por lint global posterior; errores iniciales de return inferido/reflexión corregidos sin any ni ignores |
| npm.cmd run lint -- --no-fix | PASS |
| npm.cmd run build | PASS |
| Jest focalizado challenge-progress + streak-calculator.service, --runInBand | PASS, 2 suites / 16 tests |
| node scripts/run-client-archive-pg.cjs --self-check | PASS, 7 rechazos de informe y 3 URLs inseguras |
| node --check scripts/run-client-archive-pg.cjs | PASS |
| node scripts/run-client-archive-pg.cjs | PASS, esquema limpio / 21 tests / 0 FAIL, SKIP, TODO y open handles |
| node scripts/run-client-archive-pg.cjs --legacy-upgrade | PASS, actualización legacy / rollback deliberado / recuperación / conservación / backfill / idempotencia / 21 tests |
| git diff --check | PASS |
| npm.cmd test -- --runInBand, entorno estéril en aislamiento | FAIL, 74 suites PASS / 14 FAIL / 23 SKIP; 806 tests PASS / 110 FAIL / 463 SKIP, 82.11s |
| Retry elevado solo de las 10 suites HTTP/TLS con EACCES, entorno estéril, --runTestsByPath | PASS, 10 suites / 63 tests; 8 tests HTTP/PG de recap SKIP por FOLLOWUP_HTTP_PG no activado |

No se aplican excepciones ni se atribuyen automáticamente los fallos globales a la base: cuatro suites PG requieren launchers/contextos propios. Las diez suites HTTP/TLS originales fallaron con connect EACCES de loopback dentro del aislamiento; su retry elevado pasa. El retry no repite la suite completa ni inyecta una DB en suites ajenas. Entorno estéril: allowlist de variables de SO, NODE_ENV=test, DOTENV_CONFIG_PATH a fichero vacío; sin aliases DB ni credenciales para el test global/HTTP. Los runners PG usan sus aliases propios y bloqueo explícito de red/proveedores.

## Recursos finales retenidos

- Limpio: owner `archive-1791564359847-90d7e5b488fd`, puerto loopback `53048`, manifiesto `${RUNTIME_ROOT}/AppData/Local/Temp/exom-archive-pg-BGu4oG/manifest.json`, SHA256 `eae3ee64e5577a843662e38bf656548fa8936f3318db92e2d037ab5f70383cc6`.
- Legacy: owner `archive-1791564347200-a6d151062ccc`, puerto loopback `56966`, manifiesto `${RUNTIME_ROOT}/AppData/Local/Temp/exom-archive-pg-1284go/manifest.json`, SHA256 `6980a065490fb6cc32d5b07e995d7317cd358f8fa146295a94113cc9b086a472`.
- Ambos: PostgreSQL17 cacheado `sha256:f4c66b820c6f974249089d3d16d86a3698eae11e8746eb6644b2271031e91232`; imagen, ownership nonce/labels, container ID, volumen/mount, puerto físico y SQL DB/user/data_directory comprobados; cero tablas públicas antes de DDL. Volúmenes y contenedores conservados, incluida la ejecución fallida por sandbox y todos los recursos anteriores.
- Legacy payload protegido antes/después: `c502e2fd4fdc37a7b47964e26494a630f7173a4acb44f1bf786683363976a166`. Procedencia legacy desconocida permanece desconocida.
- Retry HTTP/TLS: `${RUNTIME_ROOT}/AppData/Local/Temp/exom-archive-pg-BGu4oG/fu05-http-retry.json`, SHA256 `dff8a852bc3e8a6ee2622ec9a6b60cb33217dc350c47a8430bac99a2c9615454`; log hermano `fu05-http-retry.log`. Los 8 omitidos pertenecen a `REST-T3-PRIVACY-01 real recap HTTP/PG projection`, no a TLS.

## Fuente final y recuperación

| Path | SHA256 |
| --- | --- |
| prisma/schema.prisma | 7e4cd4adad18cb812ab8e19c594435c1ab5a6b7b421bdbaa767b4ca4a5401146 |
| prisma/migrations/20261009190000_p5fu05_global_challenge_eligibility_periods/migration.sql | beced1cac41697bcd6e2e1fada5fba397533079f40f1dab9af180724bbba5400 |
| src/modules/challenges/challenges.service.ts | e9818ee67475bdf18e7898c1e55da515d784a87685a642119d84d4fab189abfb |
| src/modules/challenges/challenge-progress.ts | 934946d5f3c0cfebb4d15cccdd96294024194c7013e8bbe554ead6fcc2fbb8ba |
| src/modules/challenges/challenge-progress.spec.ts | 5ef2b2e1659dee02334c8ae0e4b9e946b1399c9862af65aec1ed5123a1ce53ca |
| src/modules/streaks/streak-calculator.service.ts | 0bdacb3a059a7ce8ea8a586f7c3e8f6654183cb8b7f9513cfe30fed02386b887 |
| src/modules/users/client-archive.concurrency.spec.ts | 62a1377fa50537a2640fbc667c0a9df7dcdc79aed87bb2101ec8ef928b1af5db |
| scripts/run-client-archive-pg.cjs | cce84a338a6ed77f0bffec5e60a467428d71d67d793adc2cd7ecc4a46d18ff80 |

Diff tracked acumulado contra la base: +1216/-143, seis archivos; además migración y spec nuevos. Incluye trabajo conservado de escritores anteriores y normalización propia; no se presenta como delta exclusivo de esta continuación. La evidencia RED anterior no se sobrescribe. Se conservan `scripts/probe-client-deletion-lock-order.cjs`, `%SystemDrive%/` y demás trabajo existente. Sin commit: checkpoint recuperable mediante los archivos actuales, hashes y manifiestos; el padre debe guardar su parche/manifiesto final antes de entregar. Rollback local causal: unidad FU05 de schema/migración/calculadores/challenge service/tests/runner; ningún rollback remoto autorizado. Retirar una migración aplicada requiere diseño y autorización separados: no ejecutar DOWN ni borrar columnas/datos como parte de este checkpoint.

## Pendientes

Verificador independiente: comprobar las mismas fuentes, repetir un check observado y orquestar únicamente los contextos PG obligatorios apropiados con recursos propios frescos/retención. `scripts/run-adherence-integration.cjs off|on` contiene las referencias de nonce legacy84/tracking y selección de suites, pero rechaza checkout con .env y ejecuta stop/rm de su contenedor: **no lanzarlo sin reconciliar los límites vigentes de retención**. No basta con asignar TEST_DATABASE_URL de FU05 a esas suites. Las suites pendientes son adherence-history-baseline, adherence-assignment-journal, adherence-catalog-journal y adherence-commit-resolver concurrency; guardas: Own history launcher required / Owned PG fixture required / Isolated DB required. El padre conserva revisión nativa, task/Engram mirror, commits y entrega. Engram atribuido no disponible; no se inventó registro de sesión.

## Fallos exactos del test global inicial

Registro reproducible del resumen terminal del comando global (nombres únicos; algunos errores de beforeAll/afterAll aparecen duplicados en Jest). Las suites HTTP/TLS indicadas aquí tienen retry PASS arriba; las cuatro suites PG siguen pendientes.

- `modules/adherence/adherence-history-baseline.concurrency.spec.ts :: coherent initial history epoch on PostgreSQL › captures full preexisting graph after untimed and bulk membership/diet edits`
- `modules/adherence/adherence-history-baseline.concurrency.spec.ts :: coherent initial history epoch on PostgreSQL › drains an inflight membership and catalog writer before fresh capture`
- `modules/adherence/adherence-history-baseline.concurrency.spec.ts :: coherent initial history epoch on PostgreSQL › holds competing writers until commit and allocates all 13 sources after the boundary`
- `modules/adherence/adherence-history-baseline.concurrency.spec.ts :: coherent initial history epoch on PostgreSQL › aborts on bounded lock timeout, preserves preceding events, and retries atomically`
- `modules/adherence/adherence-history-baseline.concurrency.spec.ts :: coherent initial history epoch on PostgreSQL › rolls back created tables and images on a late capture failure then retries`
- `modules/adherence/adherence-history-baseline.concurrency.spec.ts :: coherent initial history epoch on PostgreSQL › enforces private owner-only append-only storage while existing restricted source writes work`
- `modules/adherence/adherence-history-baseline.concurrency.spec.ts :: coherent initial history epoch on PostgreSQL › captures coherently with NULL namespace when migration owner cannot read control functions`
- `modules/adherence/adherence-history-baseline.concurrency.spec.ts :: coherent initial history epoch on PostgreSQL › requires matching source owners instead of relying on potentially filtered RLS policies`
- `modules/adherence/adherence-history-baseline.concurrency.spec.ts :: coherent initial history epoch on PostgreSQL › stores full xid and real optional namespace, validates row keys and rejects non-source images`
- `modules/adherence/adherence-assignment-journal.concurrency.spec.ts :: assignment row journal on actual PostgreSQL tables › captures permitted nonowner INSERT/UPDATE/DELETE with complete images on both sources`
- `modules/adherence/adherence-assignment-journal.concurrency.spec.ts :: assignment row journal on actual PostgreSQL tables › rolls back a restricted source mutation and its journal on subsequent failure`
- `modules/adherence/adherence-assignment-journal.concurrency.spec.ts :: assignment row journal on actual PostgreSQL tables › denies direct journal access, sequence use, execution and hostile trigger attachment`
- `modules/adherence/adherence-assignment-journal.concurrency.spec.ts :: assignment row journal on actual PostgreSQL tables › gates foreign-schema and same-schema spoof OIDs even for owner-attached triggers`
- `modules/adherence/adherence-assignment-journal.concurrency.spec.ts :: assignment row journal on actual PostgreSQL tables › retains the migration journal owner, fixed search path and no bypass role grants`
- `modules/adherence/adherence-assignment-journal.concurrency.spec.ts :: assignment row journal on actual PostgreSQL tables › reconstructs all three pretransaction links after a full SQL bulk delete`
- `modules/adherence/adherence-assignment-journal.concurrency.spec.ts :: assignment row journal on actual PostgreSQL tables › captures direct SQL inserts, moves, link key changes and full parent updates`
- `modules/adherence/adherence-assignment-journal.concurrency.spec.ts :: assignment row journal on actual PostgreSQL tables › keeps complete OLD images through user and training FK cascades`
- `modules/adherence/adherence-assignment-journal.concurrency.spec.ts :: assignment row journal on actual PostgreSQL tables › records full parent INSERT images and the corresponding links in one transaction`
- `modules/adherence/adherence-assignment-journal.concurrency.spec.ts :: assignment row journal on actual PostgreSQL tables › rejects malformed operation shapes and ordinary journal mutation`
- `modules/adherence/adherence-assignment-journal.concurrency.spec.ts :: assignment row journal on actual PostgreSQL tables › rolls back both source mutations and all journal events`
- `modules/adherence/adherence-assignment-journal.concurrency.spec.ts :: assignment row journal on actual PostgreSQL tables › separates committed full transaction identities, not observation timestamps`
- `modules/adherence/adherence-assignment-journal.concurrency.spec.ts :: assignment row journal on actual PostgreSQL tables › observes a concurrent FK insert blocked by replacement before preserving both transactions`
- `modules/adherence/adherence-catalog-journal.concurrency.spec.ts :: catalog row journal on actual PostgreSQL tables › preserves original untimed series through update and bulk replacement`
- `modules/adherence/adherence-catalog-journal.concurrency.spec.ts :: catalog row journal on actual PostgreSQL tables › captures full INSERT/UPDATE/DELETE for restricted trainings DML`
- `modules/adherence/adherence-catalog-journal.concurrency.spec.ts :: catalog row journal on actual PostgreSQL tables › captures full INSERT/UPDATE/DELETE for restricted training_blocks DML`
- `modules/adherence/adherence-catalog-journal.concurrency.spec.ts :: catalog row journal on actual PostgreSQL tables › captures full INSERT/UPDATE/DELETE for restricted training_exercises DML`
- `modules/adherence/adherence-catalog-journal.concurrency.spec.ts :: catalog row journal on actual PostgreSQL tables › captures full INSERT/UPDATE/DELETE for restricted exercises DML`
- `modules/adherence/adherence-catalog-journal.concurrency.spec.ts :: catalog row journal on actual PostgreSQL tables › captures full INSERT/UPDATE/DELETE for restricted training_groups DML`
- `modules/adherence/adherence-catalog-journal.concurrency.spec.ts :: catalog row journal on actual PostgreSQL tables › captures full INSERT/UPDATE/DELETE for restricted diet_groups DML`
- `modules/adherence/adherence-catalog-journal.concurrency.spec.ts :: catalog row journal on actual PostgreSQL tables › captures full INSERT/UPDATE/DELETE for restricted catalog_colors DML`
- `modules/adherence/adherence-catalog-journal.concurrency.spec.ts :: catalog row journal on actual PostgreSQL tables › captures full INSERT/UPDATE/DELETE for restricted diets DML`
- `modules/adherence/adherence-catalog-journal.concurrency.spec.ts :: catalog row journal on actual PostgreSQL tables › captures full INSERT/UPDATE/DELETE for restricted meals DML`
- `modules/adherence/adherence-catalog-journal.concurrency.spec.ts :: catalog row journal on actual PostgreSQL tables › captures full INSERT/UPDATE/DELETE for restricted meal_ingredients DML`
- `modules/adherence/adherence-catalog-journal.concurrency.spec.ts :: catalog row journal on actual PostgreSQL tables › captures full INSERT/UPDATE/DELETE for restricted ingredients DML`
- `modules/adherence/adherence-catalog-journal.concurrency.spec.ts :: catalog row journal on actual PostgreSQL tables › reverses combined key changes, parent moves, group SetNull and bulk cascades`
- `modules/adherence/adherence-catalog-journal.concurrency.spec.ts :: catalog row journal on actual PostgreSQL tables › does not invent history for the four colors installed before capture`
- `modules/adherence/adherence-catalog-journal.concurrency.spec.ts :: catalog row journal on actual PostgreSQL tables › rolls back all journal events and source changes atomically`
- `modules/adherence/adherence-catalog-journal.concurrency.spec.ts :: catalog row journal on actual PostgreSQL tables › shares allocation sequence and xid across interleaved assignment/catalog changes`
- `modules/adherence/adherence-catalog-journal.concurrency.spec.ts :: catalog row journal on actual PostgreSQL tables › observes actual catalog barrier blocking concurrent assignment UPDATE`
- `modules/adherence/adherence-catalog-journal.concurrency.spec.ts :: catalog row journal on actual PostgreSQL tables › denies direct journal/sequence/function access, attachment and spoofed source OIDs`
- `modules/adherence/adherence-catalog-journal.concurrency.spec.ts :: catalog row journal on actual PostgreSQL tables › enforces append-only DML, source/op/id shape checks and hardened metadata`
- `modules/recaps/recaps.controller.spec.ts :: RecapsController › rejects invalid recap status filters with 400`
- `modules/recaps/recaps.controller.spec.ts :: RecapsController › rejects draft recap status filters with 400`
- `modules/recaps/recaps.controller.spec.ts :: RecapsController › passes validated admin recap filters to the service`
- `modules/recaps/recaps.controller.spec.ts :: RecapsController › rejects the legacy notes field in review payloads`
- `modules/recaps/recaps.controller.spec.ts :: RecapsController › routes mark-feedback requests through the client endpoint`
- `modules/progress/progress.http.spec.ts :: P4 HTTP offline protocol (real controller/pipes/filter, isolated auth boundary) › accepts session completion and preserves operation identity across retries`
- `modules/progress/progress.http.spec.ts :: P4 HTTP offline protocol (real controller/pipes/filter, isolated auth boundary) › accepts legacy training completion without session fields or operation headers`
- `modules/progress/progress.http.spec.ts :: P4 HTTP offline protocol (real controller/pipes/filter, isolated auth boundary) › rejects invalid training completion payloads and operation headers before service forwarding`
- `modules/progress/progress.http.spec.ts :: P4 HTTP offline protocol (real controller/pipes/filter, isolated auth boundary) › keeps conflict revision and canonical historical values in the actual HTTP error`
- `modules/progress/progress.http.spec.ts :: P4 HTTP offline protocol (real controller/pipes/filter, isolated auth boundary) › transports stable operation metadata and the original revision in the response envelope`
- `modules/progress/progress.http.spec.ts :: P4 HTTP offline protocol (real controller/pipes/filter, isolated auth boundary) › accepts legacy payloads without headers, rejects incomplete headers and keeps role enforcement`
- `modules/adherence/adherence-commit-resolver.concurrency.spec.ts :: PG17 conditional commit metadata › resolves committed metadata or fails closed with actual tracking off`
- `modules/adherence/adherence-commit-resolver.concurrency.spec.ts :: PG17 conditional commit metadata › does not resolve a held inflight transaction then resolves its commit`
- `modules/adherence/adherence-commit-resolver.concurrency.spec.ts :: PG17 conditional commit metadata › never resolves an actual rollback`
- `modules/adherence/adherence-commit-resolver.concurrency.spec.ts :: PG17 conditional commit metadata › rejects absent/mismatched/recovery origin before SQL`
- `modules/adherence/adherence-commit-resolver.concurrency.spec.ts :: PG17 conditional commit metadata › uses real SQL permission denial without granting metadata access`
- `modules/adherence/adherence-commit-resolver.concurrency.spec.ts :: PG17 conditional commit metadata › rejects actual forgotten initdb status and missing timestamp`
- `modules/adherence/adherence-commit-resolver.concurrency.spec.ts :: PG17 conditional commit metadata › compares actual commit at before/equal/after microsecond cutoffs`
- `modules/users/users.controller.spec.ts :: UsersController › rejects invalid role filters with 400`
- `modules/users/users.controller.spec.ts :: UsersController › accepts an explicit archive boolean true for the current admin`
- `modules/users/users.controller.spec.ts :: UsersController › accepts an explicit archive boolean false for the current admin`
- `modules/users/users.controller.spec.ts :: UsersController › refuses malformed archive state false without changing the account`
- `modules/users/users.controller.spec.ts :: UsersController › refuses malformed archive state true without changing the account`
- `modules/users/users.controller.spec.ts :: UsersController › refuses malformed archive state null without changing the account`
- `modules/users/users.controller.spec.ts :: UsersController › refuses malformed archive state 0 without changing the account`
- `modules/users/users.controller.spec.ts :: UsersController › rejects unknown archive filters and extra account-state fields`
- `modules/users/users.controller.spec.ts :: UsersController › passes validated query params to the service`
- `modules/users/users.controller.spec.ts :: UsersController › passes a validated training note reply to the service`
- `modules/users/users.controller.spec.ts :: UsersController › rejects training note replies longer than 1000 characters`
- `modules/progress-photos/progress-photos.controller.spec.ts :: ProgressPhotosController HTTP contracts › validates bounded history pagination and sends an authenticated client context`
- `modules/progress-photos/progress-photos.controller.spec.ts :: ProgressPhotosController HTTP contracts › rejects non-civil dates, unstable operation IDs, and unknown association fields before service execution`
- `modules/progress-photos/progress-photos.controller.spec.ts :: ProgressPhotosController HTTP contracts › limits admin-targeted routes to admins and forwards the explicit target`
- `modules/progress-photos/progress-photos.controller.spec.ts :: ProgressPhotosController HTTP contracts › streams a file only through the protected photo route for CLIENT`
- `modules/progress-photos/progress-photos.controller.spec.ts :: ProgressPhotosController HTTP contracts › streams a file only through the protected photo route for ADMIN`
- `modules/progress-photos/progress-photos.controller.spec.ts :: ProgressPhotosController HTTP contracts › streams a file only through the protected photo route for SUPER_ADMIN`
- `prisma/pool-tls.spec.ts :: verified PostgreSQL TLS and connection failures › rejects untrusted certificates and trusted certificates with the wrong hostname (custom CA: false)`
- `prisma/pool-tls.spec.ts :: verified PostgreSQL TLS and connection failures › rejects untrusted certificates and trusted certificates with the wrong hostname (custom CA: true)`
- `prisma/pool-tls.spec.ts :: verified PostgreSQL TLS and connection failures › reports the TLS failure even if pool cleanup fails (false)`
- `prisma/pool-tls.spec.ts :: verified PostgreSQL TLS and connection failures › reports the TLS failure even if pool cleanup fails (true)`
- `modules/identity/identity.http.spec.ts :: P5 identity HTTP authorization and request identity › exposes only the safe recovery receipt for IDENTITY_RECOVERY_PENDING through the production filter`
- `modules/identity/identity.http.spec.ts :: P5 identity HTTP authorization and request identity › exposes only the safe recovery receipt for ACCOUNT_DELETION_PENDING through the production filter`
- `modules/identity/identity.http.spec.ts :: P5 identity HTTP authorization and request identity › denies ADMIN access to email/status and admin creation`
- `modules/identity/identity.http.spec.ts :: P5 identity HTTP authorization and request identity › denies CLIENT access to email/status and admin creation`
- `modules/identity/identity.http.spec.ts :: P5 identity HTTP authorization and request identity › rejects malformed status false instead of activating the account`
- `modules/identity/identity.http.spec.ts :: P5 identity HTTP authorization and request identity › rejects malformed status true instead of activating the account`
- `modules/identity/identity.http.spec.ts :: P5 identity HTTP authorization and request identity › rejects malformed status 0 instead of activating the account`
- `modules/identity/identity.http.spec.ts :: P5 identity HTTP authorization and request identity › rejects malformed status null instead of activating the account`
- `modules/identity/identity.http.spec.ts :: P5 identity HTTP authorization and request identity › preserves actor and idempotency key for a valid state change`
- `modules/assignments/rir-cycle.http.spec.ts :: RIR HTTP controller, role guard and strict payload › exposes the versioned envelope and passes explicit cancellation`
- `modules/assignments/rir-cycle.http.spec.ts :: RIR HTTP controller, role guard and strict payload › rejects role CLIENT before invoking management`
- `modules/assignments/rir-cycle.http.spec.ts :: RIR HTTP controller, role guard and strict payload › rejects role UNKNOWN before invoking management`
- `modules/assignments/rir-cycle.http.spec.ts :: RIR HTTP controller, role guard and strict payload › rejects missing operation/config, fractional revision and unknown root fields`
- `modules/assignments/rir-cycle.http.spec.ts :: RIR HTTP controller, role guard and strict payload › propagates stale revision as HTTP 409`
- `modules/achievements/achievements.controller.spec.ts :: AchievementsController › allows clients to fetch their unlocked achievements`
- `modules/achievements/achievements.controller.spec.ts :: AchievementsController › rejects ADMIN users from fetching their unlocked achievements`
- `modules/achievements/achievements.controller.spec.ts :: AchievementsController › rejects SUPER_ADMIN users from fetching their unlocked achievements`
- `modules/achievements/achievements.controller.spec.ts :: AchievementsController › allows clients to fetch the achievements catalog`
- `modules/achievements/achievements.controller.spec.ts :: AchievementsController › rejects ADMIN users from fetching the achievements catalog`
- `modules/achievements/achievements.controller.spec.ts :: AchievementsController › rejects SUPER_ADMIN users from fetching the achievements catalog`
- `modules/client-deletion/client-deletion.http.spec.ts :: F004 deletion HTTP authorization and confirmation › denies role ADMIN for deletion and status reads`
- `modules/client-deletion/client-deletion.http.spec.ts :: F004 deletion HTTP authorization and confirmation › denies role CLIENT for deletion and status reads`
- `modules/client-deletion/client-deletion.http.spec.ts :: F004 deletion HTTP authorization and confirmation › denies role  for deletion and status reads`
- `modules/client-deletion/client-deletion.http.spec.ts :: F004 deletion HTTP authorization and confirmation › rejects invalid confirmation {}`
- `modules/client-deletion/client-deletion.http.spec.ts :: F004 deletion HTTP authorization and confirmation › rejects invalid confirmation {"confirmation":true}`
- `modules/client-deletion/client-deletion.http.spec.ts :: F004 deletion HTTP authorization and confirmation › rejects invalid confirmation {"confirmation":"eliminar"}`
- `modules/client-deletion/client-deletion.http.spec.ts :: F004 deletion HTTP authorization and confirmation › rejects invalid confirmation {"confirmation":"ELIMINAR","extra":"ignored"}`
- `modules/client-deletion/client-deletion.http.spec.ts :: F004 deletion HTTP authorization and confirmation › returns accepted, never completed, while cleanup is pending`
- `modules/adherence/adherence-config.controller.spec.ts :: AdherenceConfigController › passes validated client identity and date to authorized service`
- `modules/adherence/adherence-config.controller.spec.ts :: AdherenceConfigController › rejects invalid replacement bodies before any write`
