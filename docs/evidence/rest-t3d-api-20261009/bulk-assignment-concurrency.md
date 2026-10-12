# REST-T2B-FU-02 — aceptación bulk multifila: RED confirmado

> Copia saneada para entrega: ubicaciones normalizadas; resultados, fechas y hashes conservan su significado histórico y corresponden al snapshot privado original, no a esta copia. WORKSPACE_ROOT identifica la coordinación; SDK_ROOT el SDK instalado; RUNTIME_ROOT las herramientas locales; TEST_ARTIFACT_ROOT los recursos privados retenidos, no publicados.


Fecha: 2026-10-09. Estado: **PARTIAL / FU-02 OPEN**; no cierre P5.
API: `${WORKSPACE_ROOT}/exom-api`.
Base: `66b177da520b4872b968f70d142410d8d18ade2c`, rama `feat/progreso-adherencia-p4`.
Upstream confirmado: `c383d47f4aa8217f727acf33e4c1900c0866b7bd`.
Raíz coordinadora no Git: `${WORKSPACE_ROOT}/`; no inicializada ni editada.
Criterio: recibo REST-T2B, FU-02 exige resultados/rollback/retry de bulk opuestos antes del cierre P5.

## Casos y mecanismo

Se añadieron dos expansiones a `client-archive.concurrency.spec.ts` (+211 líneas).
Registro exacto nuevo: `conserva la intención bulk multifila opuesta y las tareas con rollback=false` (FAIL)
y `conserva la intención bulk multifila opuesta y las tareas con rollback=true` (PASS).
El recuento real es **12 originales + 2 nuevos = 14**, no 11 originales; los 12 originales PASS.
Comparación textual: retirando exclusivamente imports y bloque nuevos, fuente idéntica a HEAD.
Fixtures propios: un cliente, seis admins A–F, seis asignaciones, métrica y tarea por caso.
Inicialmente A/B/E activos y C/D/F inactivos; payload primero `[F,D,C]`, opuesto `[B,A]`, sin ordenar.
Se ejecutan `UsersService.updateClientAssignments` y `ClientFollowUpTasksService.update` completos.
La notificación usa `NotificationsService.queueTemplate` real, dentro de la misma transacción.
Sin lifecycle/cron ni llamadas Firebase/FCM/email/R2; no sustitución SQL de métodos de negocio.
Los proxies solo retienen callbacks transaccionales después de ejecutar los delegates originales.
Barras liberadas en finally, clientes desconectados; se conservan los timeouts de producción.

## Interleaving retenido y defecto

1. La edición de tarea por A, asignada a B, retiene sus locks tras el callback real.
2. Primer bulk intenta desactivar A/B/E y espera a la tarea: UPDATE multifila probado antes de liberarla.
3. Tarea confirma; primer bulk desactiva A/B/E, reactiva C/D/F y queda retenido antes de commit/rollback.
4. Bulk opuesto lee todavía A/B/E activos; decide desactivar solo E y espera al primero.
5. Se retiene PID/query/blockers del segundo antes de liberar el primero.
Commit: tarea PID75 → bulk1 PID73 → bulk2 PID74; grafos `73:[75]` y `74:[73]`, wait `Lock`.
Rollback: tarea PID74 → bulk1 PID75 → bulk2 PID73; grafos `75:[74]` y `73:[75]`, wait `Lock`.
Consultas exactas y snapshots de seis filas están en `10.log`; ambas aristas observadas antes del release correspondiente.
**RED:** ambos bulk del caso commit cumplen sin error, pero el segundo devuelve C/D/F en vez de B/A.
Persistencia observada: A/B/E inactivos, C/D/F activos; la intención opuesta no se aplica.
Causa acotada: decisiones de sync calculadas sobre snapshot antiguo, sin exclusión antes de leer las asignaciones.
SQLSTATE: **ninguno observado**; no hubo error PostgreSQL ni víctima de deadlock. No se inventa `40P01`.
Se detuvo implementación tras el RED; producción permanece intacta y requiere superficie adicional autorizada por el padre.

## Garantías y límites observados

La tarea completa conserva propietario/creador/asignado/status, cambia título y versión 1→2; fila íntegra coincide.
Métrica poblada idéntica en ambos casos; los seis IDs/created_at originales sobreviven en snapshots.
Commit: tres notificaciones PENDING de superadmin a C/D/F; no envío externo. Assert de respuesta opuesta falla.
Rollback: excepción deliberada exacta, cero notificaciones persistidas, opuesto B/A exacto y seis filas esperadas.
Retry del mismo payload `[F,D,C]`: respuesta/fila correctas, tres notificaciones propias, métrica intacta.
Tras retry: A recibe ForbiddenException; superadmin obtiene la misma tarea completa sin cambios.
Las assertions posteriores al RED del caso commit (estado esperado y autorización A) no fueron ejecutadas.
No se acredita libertad universal de deadlocks, histórico exhaustivo FU-05 ni cierre global FU-03/FU-04.
TDD: inicialmente brecha de cobertura sin bug probado; no RED artificial. El primer runner produjo RED real.
GREEN: no alcanzado para FU-02; solo la variante rollback/retry PASS, sin modificar assertions para ocultar el fallo.

## Verificación y recursos retenidos

`node scripts/run-client-archive-pg.cjs`: FAIL exit1; 13 PASS/1 FAIL, 14 total, pending/TODO/openHandles=0.
`node node_modules/eslint/bin/eslint.js src/modules/users/client-archive.concurrency.spec.ts --no-fix`: FAIL exit1;
87 errores/3 warnings nuevos: 84 de formato y 3 errores de tipado unsafe (Reflect/bind/matcher), sin suppressions.
`node node_modules/typescript/bin/tsc --project tsconfig.json --noEmit --incremental false --pretty false`: PASS exit0.
`git diff --check`: PASS exit0; repetir después de cualquier edición futura.
Runner auditado antes de escrituras: entorno limpio, dotenv vacío y bloqueo de red/proveedores; sin fallback de credenciales.
Owner/nonce `archive-1791546840668-3859a27a59f3`; contenedor `exom-archive-1791546840668-3859a27a59f3`.
ID `7cc30fa3899b032f73aee74aa874304bd124a9500027f5f45d507e5896e35f64`; volumen homónimo con sufijo `-data`.
Imagen PG17 `sha256:f4c66b820c6f974249089d3d16d86a3698eae11e8746eb6644b2271031e91232`, puerto exclusivo loopback 52528.
Labels owner, imagen/montaje RW, PGDATA, SQL DB/role `exom_ci` y public vacío (0 tablas) verificados antes del DDL.
92 migraciones PASS; solo fixtures propios limpiados; contenedor/volumen nuevos y recursos anteriores retenidos.
Artefactos: `${RUNTIME_ROOT}/AppData/Local/Temp/exom-archive-pg-bM328U/{manifest.json,jest.json,9.log,10.log}`.
SHA256 manifest `3ec359560de9581213ddfa99408dad8e342f43683669e9737cfb2109923eee2e`; Jest `04149d62fa0ddf5669d61a502859701a1d91aec7809f12a89c6802a798d480e5`.
SHA256 migraciones `9fdac98f018cb48ea9ce98c2d004fb357adc1e1b251888d8b4035ad16eeffa3a`; ejecución `5b52a9df8105430f183fc4a321d0dbd194cae545f69fd357f8e831a0568492bd`.
Fuente antes `09f4462ede545c02881714916e71dbc0b504c684d5e818cadcf7de36497bc9d5`; después `2704e8c05a6b41500ffa573e50b0f526ddc960d64a21c3e8aaf2d1be8013e7fc`.
19/19 fuentes del manifest sellado y 2/2 recibos originales idénticos; probe y cuatro caches ajenos idénticos antes/después, no ejecutados.
Sin suite P5 completa, live Firebase/JWT, despliegue, publicación ni P6. Revisión nativa y commit pendientes del padre.
La excepción U2 no se aplica: el host nativo debe solicitar grant interactivo del target API antes de encolar esta nueva unidad.

## Continuación autorizada — GREEN 2026-10-09T12:11:24Z

**Estado actual: IN_PROGRESS / verificación focal PASS; revisión independiente/nativa y commit pendientes del padre.**
Este añadido sustituye solo el estado operativo PARTIAL anterior; conserva íntegros el RED y sus artefactos.
`REST-T2B-FU02-LOSTINTENT-01`: fix mínimo de dos líneas en UsersService (import + await).
`lockClientDayProgress(tx, clientId)` se adquiere al entrar en la transacción, ANTES de leer/calcular asignaciones.
Usa el namespace existente diario y la barrera compartida de catálogo, antes de usuarios/asignaciones; sin nuevas políticas.
Sin migraciones, restricciones, cambios de permisos/roles/archivo, refactor ni regeneración de contratos.
Tests: 12 originales íntegros + mismos dos nuevos; se mantiene la intención exacta `[F,D,C]` frente a `[B,A]`.
Se eliminó tipado unsafe nuevo con retornos unknown, forwarding tipado y comprobación Date; formato editado explícitamente.
Nueva prueba de espera: SELECT advisory exacto antes de leer, no el UPDATE obsoleto de la versión defectuosa.
Commit: tarea PID76 → bulk1 PID74 → bulk2 PID75; aristas `74:[76]`, `75:[74]` retenidas antes del release.
Rollback: tarea PID75 → bulk1 PID76 → bulk2 PID74; aristas `76:[75]`, `74:[76]`, wait `Lock`.
Query en las cuatro aristas: `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))::text AS "locked"`.
Resultado commit: bulk1 C/D/F; bulk2 B/A; seis filas finales exactamente B/A activas, IDs/fechas intactos.
Se añaden assertions de sobres completos (client_id, email, profile null, assigned_at y orden) para ambos bulk y retry.
Notificaciones commit: C/D/F del primero y A/B reactivados por el opuesto, cinco PENDING con sender propio exacto.
No se mantiene la antigua expectativa de tres: el segundo ahora sí reactiva sus destinatarios; no es debilitación del contrato.
Rollback/retry, autorización A/superadmin, tarea completa y métrica poblada PASS; ningún envío externo.

`node scripts/run-client-archive-pg.cjs`: PASS exit0, **14/14**, sin failed/pending/TODO/openHandles; bytes finales.
Primer GREEN también 14/14 en `exom-archive-pg-dHZBo1`, owner `archive-1791547703921-7bd76f553cef`, puerto54336; retenido.
Lint inicial tras fix: FAIL por un único formato; edición explícita y repetición funcional fresca, sin ocultar ese fallo.
`node node_modules/eslint/bin/eslint.js src/modules/users/users.service.ts src/modules/users/client-archive.concurrency.spec.ts --no-fix`: PASS exit0, cero errores/warnings.
`node node_modules/typescript/bin/tsc --project tsconfig.json --noEmit --incremental false --pretty false`: PASS exit0.
`git diff --check`: PASS exit0 final, incluida esta adición documental.
Unit adicional identificado: `src/modules/users/users.service.spec.ts`, Jest/ts-jest de package.json, mocks con $queryRaw.
Unit adicional NOT_RUN: host tiene TEST_DATABASE_URL heredado y setup-database lo verifica; exige invocación estéril distinta.
No se ejecuta contra ese destino no auditado ni se inventa runner/configuración; aceptación PG de servicio sí ejecutada.

Run final: `${RUNTIME_ROOT}/AppData/Local/Temp/exom-archive-pg-rqN0TA`; 92 migraciones PASS.
Owner `archive-1791547865789-e5d1bfcbefc0`, contenedor `exom-archive-1791547865789-e5d1bfcbefc0`, volumen sufijo `-data`.
ID `bb15f38a20604f6fbfbe1e5650fa3bdf8b13ca0ae3ceba756113d2ec140ef57e`; loopback exclusivo52530, nunca55493.
Misma imagen PG17 fijada arriba; owner/imagen/montaje RW/PGDATA/DB-role exom_ci/public vacío verificados antes del DDL.
Runner/guard/setup/config/package conservan los bytes auditados del RED; entorno estéril y bloqueo de proveedores intactos.
SHA256 manifest `1c4d5b2107700d18c5f3be3cbfd7231bee88d433a62fd98f60ae02d213a5b3d7`; Jest `a7d9e24f2dcd61386956cd94327471d6a41f05d47498bf92cd0de5c651e24c37`.
SHA256 9.log `7dafc45fc4356ef42053b432a3006edb2ac7cbec5a31241d17ce3970ac7284d7`; 10.log `9f5f88ff502d04aa1d6cc17588049f8d21f544754db8bb625cc4792d8c01adb3`.
UsersService antes `ae26e3bcdff41b5fa297271ee2a0dc3336977097fb8a0cf298fd2eff951dbea1`, después `9abb7c05a9a58d82f6b881c1b0aff554eced150ad7eaf3acfd6fd9d0afcef232`.
Test final `569c2ee91bd32393ad2e65917aa5e817aa5159c5cd0b45d81e7db838e0aea162` coincide con manifest final.
19/19 pins y 2/2 recibos sellados estables; cinco ajenos estables; RED manifest conserva SHA original. Todos los recursos retenidos.
Diff fuente acumulado +360: test +358 por formato/tipos/assertions completas, producción +2; supera forecast, sin code-golf.
Recibo acumulado 118 líneas; carga total supera orientación400 y queda señalada al padre para ASSESS, sin ampliar scope.
Aprendizaje: evitar deadlocks no prueba aplicar intención; el lock debe preceder la lectura que decide altas/bajas/reactivaciones.
FU-02/P5 no DONE; no prueba universal de deadlocks, cierre FU-03/FU-04/FU-05, suite global, live providers ni despliegue.

## Normalización documental — verificación independiente comunicada, 2026-10-09

**Estado vigente: FU-02 IN_PROGRESS; verificación independiente PASS, revisión nativa y commit pendientes.**
Procedencia: resultados finales de `gentle-ai-verify` comunicados por el padre; no ejecuciones de este escritor documental.
No se atribuye aprobación nativa/modelo ni se aplica la excepción U2 a este candidato.
Este añadido sustituye prospectivamente los NOT_RUN de unit/Nest y la revisión independiente pendiente anteriores.
Los 118 renglones históricos, fallos RED, quoting, logs y recursos conservan exactamente sus bytes; no waiver funcional.
Dictamen independiente: PASS de orden/comportamiento, intención opuesta, respuestas completas, rollback/retry y autorización.
Tarea, histórico y ownership de notificaciones preservados; 12 casos originales textualmente idénticos; sin hallazgos bloqueantes.

### Comandos y resultados independientes

`node scripts/run-client-archive-pg.cjs`: PASS exit0, **14/14**, 92 migraciones; cero failed/pending/TODO/openHandles.
`node node_modules/eslint/bin/eslint.js src/modules/users/users.service.ts src/modules/users/client-archive.concurrency.spec.ts --no-fix`: PASS exit0.
`node node_modules/typescript/bin/tsc --project tsconfig.json --noEmit --incremental false --pretty false`: PASS exit0.
`git diff --check`: PASS exit0 independiente; este escritor solo repite el check documental, no los comandos funcionales.
Unit con Jest instalado, spawn de entorno estéril whitelist y sin credenciales/configuración heredadas:
`node node_modules/jest/bin/jest.js --runInBand --no-cache --runTestsByPath src/modules/users/users.service.spec.ts --detectOpenHandles --json --outputFile ${RUNTIME_ROOT}/AppData/Local/Temp/exom-fu02-independent-iApQG2/unit.json --cacheDirectory ${RUNTIME_ROOT}/AppData/Local/Temp/exom-fu02-independent-iApQG2/unit-cache`.
Resultado **23/23 PASS**, sin pending/openHandles; 36 módulos locales auditados, dotenv/Firebase ausentes.
Build Nest real en child estéril, no reutilización del build U2:
`node node_modules/@nestjs/cli/bin/nest.js build --path ../../../../AppData/Local/Temp/exom-fu02-independent-iApQG2/tsconfig.build.json`.
Resultado PASS exit0; 5959 rootNames originales, mismas opciones semánticas, solo outputs/buildinfo redirigidos.
7906 inputs CURRENT estables; nuevo await emitido en JS. Configuración/whitelist retenidas, sin volcar secretos.
Dos intentos de quoting/metadata FAIL exit1 antes de ejecutar código están preservados; corrección posterior sin waiver.

### PostgreSQL y grafos independientes retenidos

Owner/nonce `archive-1791548419055-bff40a8d0406`; contenedor `exom-archive-1791548419055-bff40a8d0406`.
Volumen `exom-archive-1791548419055-bff40a8d0406-data`, loopback exclusivo51082, distinto de55493.
ID `64ccd9b14092a24ec6ca618a7536ff3a2f09ca1bf3951f31c38bb6e625b1353f`.
Imagen `sha256:f4c66b820c6f974249089d3d16d86a3698eae11e8746eb6644b2271031e91232`.
Antes de DDL: nonce/imagen/montaje propio único RW/PGDATA/SQL DB-role exom_ci/directorio/public0 verificados; diez comandos internos exit0.
Commit tarea75 → bulk73 → opuesto74; rollback tarea74 → bulk75 → opuesto73; cuatro waits `Lock` observados ANTES del release.
Query exacta: `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))::text AS "locked"`; no afirmación universal de deadlocks.
Directorio PG `${RUNTIME_ROOT}/AppData/Local/Temp/exom-archive-pg-Da5muR`:
manifest SHA256 `d0456f18fc418c32a2d47985a62ef1fd46c13148c40fefeff43d0e170a29148b`;
Jest SHA256 `195138c2586e2c24bd6cee99c8582d05e18d3853511031f0fc6325c62fb2ce9d`;
10.log SHA256 `2523e5d8f640021e9cc7f9d0f8d3e21d8ee1b203fa1c998ca48941e5778a5a1a`.

### Artefactos, pins y límites del freeze

Directorio unit/build `${RUNTIME_ROOT}/AppData/Local/Temp/exom-fu02-independent-iApQG2`:
unit.json SHA256 `cb01f747aba45f75f66d6c0a330c85fec7e994dacaf8b0f0f23769f5eecb36f4`;
build inputs SHA256 `8fe2a46ad65ef0f02c7b37e65b2487b7341c9d6994daaf284e40c07a7b91b4ed`;
buildinfo SHA256 `f5cc432d5baa45c2b316ce4139dacc3ef5e6f74e64373c2642d3dd6d037a6a6a`;
build log vacío SHA256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
Independiente: 29/29 pins fuente/recibos/ajenos y 1124 outputs/artefactos previos/dist/buildinfo/tres directorios PG antiguos estables.
Sin regeneración, source writes ni operaciones nativas; todos los recursos retenidos. Git sin cambios durante esa verificación.
Normalización: fuente UsersService `9abb7c05a9a58d82f6b881c1b0aff554eced150ad7eaf3acfd6fd9d0afcef232` intacta;
test `569c2ee91bd32393ad2e65917aa5e817aa5159c5cd0b45d81e7db838e0aea162` intacto.
Prefijo documental118 SHA256 `2a97f4ea8fd31e3fd8c03134f13ac8cd10b9a827adc2b9ec95f1fc0f4d5c2f20`; hash nuevo se entrega al padre para freeze.
No acreditados: suite1377, auditoría histórica exhaustiva, challenges poblados, Firebase/JWT real, FU-03/04/05 ni cierre final P5.
Aprendizaje confirmado: unit y build actuales requieren evidencia estéril propia; un build anterior no acredita el nuevo await.
