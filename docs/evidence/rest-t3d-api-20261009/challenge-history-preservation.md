# FU05 — diagnóstico test-first de histórico GLOBAL manual

> Copia saneada para entrega: ubicaciones normalizadas; resultados, fechas y hashes conservan su significado histórico y corresponden al snapshot privado original, no a esta copia. WORKSPACE_ROOT identifica la coordinación; SDK_ROOT el SDK instalado; RUNTIME_ROOT las herramientas locales; TEST_ARTIFACT_ROOT los recursos privados retenidos, no publicados.


- Fecha UTC: 2026-10-09; ejecución causal 14:45:58.857–14:46:16.932.
- Estado: REST-T2B-FU05-GLOBAL-HISTORY-01 OPEN; R9 BLOCKED por RED causal.
- P5 no completada; sin GREEN, corrección productiva, despliegue ni publicación.
- API: `728d90626add098427e7e19341e5ad7b15eb4ff4`, rama `feat/progreso-adherencia-p4`.
- Upstream verificado: `origin/feat/progreso-adherencia-p4`; cambios ajenos preservados.
- Fuente original R8: `d208a34344289bd6016aceade30bdc18e76bffa7366616ec357c193b0cd3b6dd`.
- Fuente causal SHA256: `da75996388311588ac280a42167d74d362caaa094933e9c1ce03d3cd348a5ec1`.
- Runner intacto SHA256: `8ddb17cf9bb139beaf5ae7fbd3b7108641dc97897328d10f5f9e0be68a60c42a`.
- Excepción expresa: omitido únicamente user.deleteMany del afterAll; ambos disconnects intactos.
- Comparación byte a byte con HEAD: prefijo no-bulk intacto salvo import de logros/teardown autorizado.
- Comparación byte a byte: cuerpo R8 y todo el sufijo intactos; se mantienen 15 casos.
- Todas las assertions previas, grafos, tareas, métricas y notificaciones bulk se conservan.
- Fixture tipada: Challenge MAIN_GOAL, GLOBAL, manual, objetivo 10, sin deadline ni regla automática.
- Creación 2026-09-01; asignación 2026-09-02; completado 2026-09-03, todas 00:00:00Z.
- Valor inicial 10, completado true, assignment_source GLOBAL; propietario coach a inicialmente activo.
- Otro cliente sintético sigue asignado al mismo coach y comparte definición e histórico alcanzado.
- Reentrada requiere AchievementsService real: ensamblado dentro del bulk, sin mocks de retos/logros.
- refreshManualAssignments conserva completed_at cuando valor >= objetivo; no justifica el reset observado.
- Contrato: recuperar valor, completado, fechas y procedencia histórica; hoy ChallengeClient es su único almacenamiento identificado.
- Challenge.created_by conserva propietario; no se introduce política ni modelo de retención.

## Comandos y resultados observados
- `node node_modules/typescript/bin/tsc --project tsconfig.json --noEmit --incremental false --pretty false`: original PASS/0; final PASS/0 antes de PG.
- `node node_modules/eslint/bin/eslint.js src/modules/users/client-archive.concurrency.spec.ts --no-fix`: original PASS/0; cuatro errores de formato/1 corregidos manualmente; final PASS/0.
- `git diff --check`: PASS/0 antes de cada ejecución PG; sin auto-fix.
- Primer `node scripts/run-client-archive-pg.cjs`: FAIL/1, Jest 13 PASS/2 FAIL, 15 total; NO es RED de producto.
- Causa primer fallo: dependencia AchievementsService undefined al reentrar; assertions históricas aún no alcanzadas.
- Durante corrección, TSC FAIL/2 por import dinámico NodeNext; resuelto con import estático, sin casts inseguros.
- Segundo `node scripts/run-client-archive-pg.cjs`: FAIL/1; migrate deploy PASS/0; Jest FAIL/1.
- Ejecución causal: 13 PASS, 2 FAIL, 15 total; pending/todo/runtime errors/open handles = 0.
- Fallan exactamente «conserva la intención bulk multifila opuesta y las tareas con rollback=false/true» en expect(historySnapshots), línea 1147.
- Las assertions antiguas de ambos bulk pasan antes de la nueva comparación; los otros 13 casos pasan.
- R8 solicitud real: PASS; destructiveCalls=0, externalCalls=0, deletionJobs=0; 23 usuarios antes/después, 57 tablas comparadas.

## Causalidad y antes/después
- false: fila inicial `c13b9908-a35c-4a8d-b7a8-8eebe09f8ec6`; reto `a3e216f4-55a9-4db6-ba3b-16e2f0878f79`.
- Primer bulk real selecciona f,d,c y saca a del scope: observación dentro de TX devuelve null; commit exitoso.
- Bulk opuesto selecciona b,a y reentra: fila nueva `2c6a0253-bf6a-4b9a-9b8b-ff5b50dc7beb`, valor 0, completado false, completed_at null.
- assigned_at pasa de 2026-09-02T00:00:00Z a 2026-10-09T14:46:15.901Z; creador y definición permanecen.
- true: fila inicial `1db079d6-c716-4ed4-b0e0-1ec7ca5bad94`; reto `8738db92-fb9d-48c4-b0af-493b8fd8fe83`.
- Primer bulk elimina dentro de TX pero rollback restaura; bulk opuesto preserva exactamente la fila inicial y todos sus campos.
- Retry real confirmado selecciona f,d,c: fila final null, pierde valor 10/completado/ambas fechas; no mera diferencia de identidad.
- Ambos casos: definición/created_by y fila del otro cliente permanecen idénticos; assertions correspondientes PASS.
- Fuente causal: syncGlobalChallengesForCreatorClient borra GLOBAL fuera de elegibilidad; materializeGlobalAssignmentForClient recrea en cero al reentrar.
- Grafo false: tarea PID75 → bulk PID73 → opuesto PID74; true: tarea PID74 → bulk PID75 → opuesto PID73.
- Ambas aristas observadas como Lock sobre pg_advisory_xact_lock(hashtextextended($1,0)); callbacks/transacciones reales, sin SQL sustitutivo.

## Recursos y checkpoint conservados
- Temp causal: `${RUNTIME_ROOT}/AppData/Local/Temp/exom-archive-pg-xder8w`; manifiesto y logs 1–10 más jest.json retenidos.
- Contenedor `exom-archive-1791557158856-028957466245`; ID `888788d53d14b51ef52b4ca447cd2ef5a751cd3d2437a0380844ea8a1880e31e`.
- Volumen propio `exom-archive-1791557158856-028957466245-data`, único montaje RW, label nonce coincidente.
- Imagen cacheada postgres:17 `sha256:f4c66b820c6f974249089d3d16d86a3698eae11e8746eb6644b2271031e91232`; pull never.
- Puerto exclusivamente 127.0.0.1:59401, distinto de 55493; DB/rol exom_ci; PGDATA /var/lib/postgresql/exom-ci-data.
- Guardas previas al DDL: identidad SQL verificada y public=0; tmpfs separado; dotenv vacío; TCP solo PG propio, HTTP/TLS/fetch bloqueados.
- SHA256 manifest.json `8e232cc1ec88490ce985d7713a2364ca25acc0501483d8a8009b6fc95a22180d`; jest.json `7fed2b1b6cbc00a41b731633f5be33be6c4169fc715c9d545f12b1bc6b0de5ce`.
- SHA256 8.log identidad `96263a0367c210eb88433a7043f4d4046bd3da4bc14713811433af01dc446a0c`; 9.log migraciones `d11f95abf1f2095a2ae7cbe41b59b54fe48b5e07d98a388e32d75653b1b07138`.
- SHA256 10.log grafos/RED `d688deecb96721efbcccc73ad7847b5f4ccc3d4b0482d01e4d313b58ea436ea4`.
- Primera fixture conservada: Temp exom-archive-pg-LOKVYH, contenedor exom-archive-1791556965327-976459d76c4b y volumen homónimo -data, puerto 59300.
- Primer manifest SHA256 `ad681ef4f5ab2d5a686333993eaf38a5fd170271979fbe535dbd2a701144a227`; 10.log `98057d2846d0e45bb1cf13a12784493d57ef3a3e3dd6bea390c1554bd28ef355`.
- Sin limpieza, borrado de usuarios, workers ni proveedores externos; datos y recursos anteriores/nuevos retenidos. Cambios fuente persistidos sin commit; parent registra checkpoint raíz y hash del recibo externamente.
- Siguiente decisión acotada: parent delimita impacto en sincronización/materialización, lectores/visibilidad y posible migración antes de autorizar implementación.
- Aprendizajes: rollback protege el histórico solo hasta el retry; ausencia de deadlock no acredita preservación; una fixture completa debe conectar el evaluador real de logros.
