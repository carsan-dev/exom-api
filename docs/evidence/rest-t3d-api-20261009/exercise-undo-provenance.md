# FU05 — procedencia individual al desmarcar ejercicios

> Copia saneada para entrega: ubicaciones normalizadas; resultados, fechas y hashes conservan su significado histórico y corresponden al snapshot privado original, no a esta copia. WORKSPACE_ROOT identifica la coordinación; SDK_ROOT el SDK instalado; RUNTIME_ROOT las herramientas locales; TEST_ARTIFACT_ROOT los recursos privados retenidos, no publicados.


Fecha: 2026-10-09. Estado: COMPLETE local para esta corrección ordinaria; no cierre de P5, revisión nativa, publicación ni despliegue.

## Alcance y base

Raíz de coordinación: `${WORKSPACE_ROOT}/`, sin Git. API real: `${WORKSPACE_ROOT}/exom-api`; rama `feat/progreso-adherencia-p4`, HEAD `f1f9340d259c114c6375f75cbc2d76835b2cb2c6`, upstream `c383d47f4aa8217f727acf33e4c1900c0866b7bd`.
Instantánea documental conservada: AGENTS SHA256 `f21dc8259e9ff8b7a02122efd9b1651a4a22859081c6871722b099c8476a38db`, plan `9332524f9d699412a19a9154a7a1db426c7d2688770d4cb6b5978db9d9e18a8c`, seguimiento `20f86a29cb552aad53613eb3dea00c823461ea2d410aad465f6f434a4e85149c`; sin cambios durante los perfiles.
Se preservaron los cambios previos del runner, specs de recap/tareas y los archivos sin seguimiento probe/cache/recibos. Sin commits, GitHub, credenciales reales, cambios del modo global ni actores nativos. La revisión de este candidato fue omitida por el usuario; este recibo no concede autoridad nativa.

## Defecto y solución mínima

El trigger renovaba un único evento agregado cuando cambiaba cualquier array no vacío, incluido undo parcial. El lector GLOBAL atribuía ese evento a los ejercicios restantes, permitiendo acreditar actividad realizada fuera de elegibilidad.
El JSON privado existente conserva ahora eventos por identidad `[exercise_id, training_exercise_id, training_session_id]`. Undo, reordenación y edición de series no renuevan eventos retenidos; altas nuevas reciben únicamente su propio evento. Se prioriza identidad exacta y se colapsan duplicados de identidad antes del fallback legacy; la promoción legacy conserva su evento conocido o permanece desconocida. No se usan `completed_at` del payload ni tiempos históricos inventados.
Cambiar la fecha sigue siendo un evento nuevo, como en el trigger anterior, sujeto a elegibilidad tanto de fecha como de escritura. El comportamiento de rachas sin periodos de elegibilidad permanece intacto. No se modifica esquema público, API, campos de entrenamiento/comida/métrica, baselines, locks o scopes.
Lectores afectados: `hasStreakActivity`/`calculateStreak` y la proyección SQL privada de `ChallengesService.recalculateAutomaticProgress`. Escritores: mark/unmark y completeTraining bulk de ProgressService, replay y SQL directo comparten el trigger PostgreSQL. La identidad coincide con las ocurrencias/sesiones existentes; no se cambian sus contratos. CodeGraph consultado primero; su índice señaló fuentes modificadas, por lo que se inspeccionó el código vivo directamente.

## RED y pruebas finales

| Comprobación y comando | Resultado | Evidencia retenida |
| --- | --- | --- |
| Helper original, Jest por ruta `challenge-progress.spec.ts` | RED: 6 PASS / 3 FAIL | Fallos de actividad inactiva, legacy desconocido e identidad retirada; no fallo de compilación |
| `node scripts/run-client-archive-pg.cjs`, SQL/servicio originales | RED: 35 PASS / 3 FAIL | `${RUNTIME_ROOT}/AppData/Local/Temp/exom-archive-pg-5oGNM2`, puerto 52590, `jest.json`/`10.log` |
| Regresión canonical + legacy/duplicado, antes de corregir precedencia | RED: 39 PASS / 1 FAIL | `${RUNTIME_ROOT}/AppData/Local/Temp/exom-archive-pg-gdWiKg`, `jest.json`/`10.log` |
| `node scripts/run-client-archive-pg.cjs`, bytes finales | PASS 40/40; 0 skipped/todo/open handles | `${RUNTIME_ROOT}/AppData/Local/Temp/exom-archive-pg-6wgNEC/manifest.json` |
| `node scripts/run-client-archive-pg.cjs --legacy-upgrade`, bytes finales | PASS 40/40 y rollback/recuperación/conservación/idempotencia | `${RUNTIME_ROOT}/AppData/Local/Temp/exom-archive-pg-EFGykX/manifest.json`, puerto 64278 |
| Jest `challenge-progress.spec.ts` + `streak-calculator.service.spec.ts`, final | PASS 21/21, 2 suites | `node node_modules/jest/bin/jest.js --config '{"rootDir":".","transform":{"^.+\\.tsx?$":"ts-jest"},"testEnvironment":"node"}' --runInBand --runTestsByPath src/modules/challenges/challenge-progress.spec.ts src/modules/streaks/streak-calculator.service.spec.ts` |

Las nueve regresiones PostgreSQL prueban undo inactivo, retirada del único elegible, conservación del elegible, reorder/edición de series, legacy desconocido, nueva ocurrencia de catálogo repetido, cambio de fecha, promoción legacy y precedencia exacta con duplicados. El orden temporal inicial se afirma mediante SQL frente a `opened_at`; la escritura elegible ocurre después de la barrera PostgreSQL. Se mantienen las 31 pruebas previas, incluidos NULL, baselines, scope, locks y expansión 409. La procedencia privada sigue ausente en payloads Prisma.

## Perfiles finales secuenciales

Comando común: `node scripts/run-recap-review-persistence.cjs <perfil>`. Directorio común: `docs/evidence/rest-t3a-20261005/`; cada carpeta conserva comando exacto, log, selección, manifest antes/después y recurso propio.

| Perfil | Resultado | Carpeta | Puerto |
| --- | --- | --- | --- |
| checks | PASS prisma generate/validate, TSC, lint no-fix, diff-check, Nest build | `run-checks-a92842bb-fb26-4980-9424-889961472fbd` | No DB |
| all | PASS 111 suites / 1418 tests | `run-all-e184a345-51c2-4e29-8090-7cb486284917` | 55212 |
| concurrency | PASS 24 suites / 390 tests | `run-concurrency-1e473d23-e04f-493a-b91d-ed514f755edf` | 56046 |
| e2e | PASS 3 suites / 46 tests | `run-e2e-c5baaea2-8d4b-4fdd-a001-c54b6a281832` | 53775 |
| pg | PASS 1 suite / 4 tests | `run-pg-a00cc259-ffcb-418f-a295-8082ffac0c04` | 59570 |
| adherence-on | PASS 6 suites / 77 tests | `run-adherence-on-f6489f60-2f04-4c4f-b4b6-0f8757ba0dba` | 59580 |

Todos los perfiles funcionales: 0 fail/skipped/todo/open handles; inventarios fuente/migraciones antes y después idénticos. Recursos Docker retenidos, sin limpieza/apagado. Cada `resource.json` registra identidad completa y prueba física/SQL previa a DDL; imágenes fijadas `sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0` (perfiles) y `sha256:f4c66b820c6f974249089d3d16d86a3698eae11e8746eb6644b2271031e91232` (archive). Loopback, recursos nuevos vacíos, usuario/database `exom_ci`, destino físico propio; puerto 55493 no utilizado. Entornos estériles y guardas sin proveedores reales; logs saneados, sin secretos ni datos personales reales.

## Pins y recuperación

| Archivo | SHA256 antes | SHA256 final |
| --- | --- | --- |
| `prisma/migrations/20261009190000_p5fu05_global_challenge_eligibility_periods/migration.sql` | `8466a0bd687b47d166efd1935a99f2eb83faf5cc1484b928942d7f5aa9300f63` | `2ec8256aa718a5f5f4f604514f4991ff01760dee659d31435ff74bdf52177cfa` |
| `src/modules/challenges/challenge-progress.ts` | `934946d5f3c0cfebb4d15cccdd96294024194c7013e8bbe554ead6fcc2fbb8ba` | `b80d14572423c5fb71cb3a2270900e1d14df74f0c95cffb3b968ffb094dd2f7e` |
| `src/modules/challenges/challenges.service.ts` | `cdc5ed8a4992f0ec499cfa0a90e9c3341e49b82af2b188355ee3b1ae015b3228` | `9221a8fcbd0350a4c9a08685b28b3333dc66fc90a23ee3234821fae86151a466` |
| `src/modules/challenges/challenge-progress.spec.ts` | `5ef2b2e1659dee02334c8ae0e4b9e946b1399c9862af65aec1ed5123a1ce53ca` | `e7ac6c6ed5c60d910297aec9d5de6371f25cd1ea9100c8c5aaafe066f70859f2` |
| `src/modules/users/client-archive.concurrency.spec.ts` | `ca88d94e43a4da12434bc78a135f87c3e4f21ff7c469074eb8d97d8561e39c1f` | `2945a1d55c08f3c27945790743ae94a10740825102ee03679baa032f0c8c9277` |

Fuentes/tests: +343/-14 = 357 líneas authored; normalización UTF-8 sin BOM/LF sólo en archivos propios antes de pruebas finales. Original SQL recuperable en `f1f9340`; snapshots finales completos en los manifests de perfiles. Las pruebas SQL anteriores de f1f9340 y GREEN intermedios 38/39 no acreditan los bytes finales y quedan sustituidas prospectivamente, sin sobrescribir sus recibos históricos.
FAIL histórico preservado: `run-checks-4a41f72c-3df5-4c1a-b585-b24f5213ae88`, cinco errores de inferencia `any` en la tabla de test; resueltos con tipos explícitos sin casts/ignores. ESLint directo de ambos `.cjs`: BLOCKED por projectService (dos parsing errors de archivos fuera del proyecto), sin desactivar configuración; el lint TypeScript final sí pasa.
Pendientes fuera de esta ejecución: verificación funcional independiente y checkpoint/commit del padre; Admin/App no repetidos, sin CI remota, producción, despliegue ni aplicación remota de migraciones. Memoria atribuida no utilizada por ausencia de identidad autorizada del runtime.
