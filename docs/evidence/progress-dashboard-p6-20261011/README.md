# CURRENT — API P6 validada, 2026-10-11

API local completa para este prerrequisito; P6/P5-04 globales todavía EN_CURSO, sin commit ni activación. La corrección del denominador sustituye la definición previa basada en comidas raíz: **todos los días con `assignment.diet_id` cuentan**, incluso dieta vacía; completado exige comidas raíz y todos sus grupos. Paridad explícita con calendario mensual entre junio/julio; evidencia obsoleta sin asignación no acredita dieta. RED1FAIL/30PASS → GREEN31/31. Semántica/contratos anteriores preservados.

## Prueba final sobre fuentes congeladas

| Perfil exacto `node scripts/run-recap-review-persistence.cjs <perfil>` | Resultado / recibo local |
| --- | --- |
| `all` | PASS111 suites/1423tests, ceroFAIL/SKIP; `../rest-t3a-20261005/run-all-3543fbba-d8d2-477f-a1d9-429d46c88d21`; manifiestos iguales. |
| `concurrency` | PASS24/390; `../rest-t3a-20261005/run-concurrency-99293b9e-4b16-469b-8649-0c0ac9b77f60`. |
| `e2e` | PASS3/46; `../rest-t3a-20261005/run-e2e-d3a0afde-3467-4fdc-ae07-8adf9205d00a`. |
| `adherence-on` | PASS6/77; `../rest-t3a-20261005/run-adherence-on-8bf2c5c8-56e7-463a-add5-5fabfc6e657f`. |
| `pg` | PASS1/4, recap fresh/legacy; `../rest-t3a-20261005/run-pg-781021f5-729a-442c-bafd-d996e7fa3bb8`. |
| `checks` | PASS Prisma generate/validate, TSC, lint no-fix, diff-check y Nest build; `../rest-t3a-20261005/run-checks-7e0ec565-cd6d-4e79-a4e8-599c75759874`. |

`npm run contract:check` final PASS235operaciones/503esquemas y OpenAPI190paths/609esquemas; `npm run prisma:format:check` PASS sin mutación. Todos los perfiles terminaron EXIT0, cero pendientes y hashes before/after iguales. `all` incluye selección canónica real PostgreSQL12/HTTP49 y calendario6. PostgreSQL17 propio tmpfs/loopback, imagen inmutable verificada antes de escrituras; recursos retenidos por el runner, sin limpieza ajena. No nueva migración; el perfil `pg` acredita únicamente recap fresh/legacy, no garantía universal de otras migraciones.

Fuentes finales SHA256: servicio calendario `0CA9F70585E03B6034FD7319BBD417E105EA146E5476C291AEEB7435D8DF2E11`, spec `6FBEB57A77DC6A3891CF1DEB26465489ED431943D52A80A22220D0A8ECDEFB34`. Documento actual posterior a pruebas: edición pasiva, no cambio funcional. [Fixture común generado por servicio real](canonical-fixture.md). Pendiente: navegador final/Admin y revisión/entrega del padre; iOS fuera de alcance; Engram PENDING.

Prefijos conservados: ejecución ordinaria FAIL110/PASS820/SKIP482 y primer owned-all `run-all-0d049bb9-c650-4b27-93e3-f1582dc39d8b` funcional1423PASS pero **FAIL del guard de inventario**: el exportador y sus JSON se añadieron durante esa ejecución. Ningún hash existente o migración cambió. El rerun final anterior congela el inventario completo; no se usa el prefijo como prueba final ni excepción de base. Los artefactos crudos de perfiles quedan locales y requieren saneamiento antes de publicación.

## Histórico — checkpoint inicial conservado, límites sustituidos solo por prueba final anterior
# P6 API — contadores semanales canónicos, 2026-10-11

Estado: implementación local parcial; no cierre P6, commit ni publicación. Base API `a1c2d61867c88c95d710026e0f5e41f821d79e48`, rama local `feat/dashboard-p6-20261011`.

## Cambio y aceptación

`diet_days_assigned` cuenta días con comidas raíz; `diet_days_completed` exige todos sus grupos canónicos completos. Calendario mensual y resumen semanal comparten la misma evaluación; variantes, IDs obsoletos y snapshots históricos conservan la semántica previa. La consulta sigue cubriendo siete días UTC completos, también futuros y cruces de mes. `total_meals`, `meals_completed`, entrenamiento, rutas y autorización no cambian. No alteración de almacenamiento, migraciones, locks ni efectos externos.

Regresiones: semana UTC entre junio/julio, denominador futuro, dieta parcial/completa/vacía/ausente, variantes duplicadas y obsoletas, snapshot histórico frente a catálogo vacío sin mutación, campos anteriores, acceso Admin asignado/rechazado y paso directo de contadores nuevos.

## Verificación de esta versión

| Comando | Resultado observado |
| --- | --- |
| `npm test -- --runInBand src/modules/calendar/calendar.service.spec.ts src/modules/users/users.service.spec.ts` antes de implementación | RED: 3 FAIL / 28 PASS; fallan solo las nuevas expectativas de contadores ausentes. |
| Mismo comando después de implementación y normalización propia | GREEN: 31 PASS / 2 suites; 0 FAIL/SKIP. |
| `npm run contract:update` | PASS; inferencia235 operaciones/503 esquemas, build y OpenAPI190 paths/609 esquemas. Solo dos archivos generados autorizados. |
| `npm run contract:check` final posterior a generación | PASS sobre los archivos generados finales. |
| `npm run lint -- --no-fix`, `npm run build`, `npm run prisma:generate`, `npm exec -- prisma validate` | PASS sobre los archivos generados finales. |
| `npm test -- --runInBand` | FAIL: 14 suites fallidas, 23 omitidas, 74 PASS; 110 tests FAIL, 482 SKIP, 820 PASS, 1412 total;125.151s. No excepción acreditada en base equivalente. |
| `git diff --check` | PASS sobre diff actual; repetir después de cambios documentales finales. |
| PostgreSQL real, e2e, concurrencia, migraciones/legacy | NOT_RUN en esta sesión: no destino aislado identificado; este cambio no altera almacenamiento/concurrencia. Los recibos anteriores no son reruns. |

Fallo de guardas PostgreSQL: `adherence-history-baseline.concurrency.spec.ts`, `adherence-assignment-journal.concurrency.spec.ts`, `adherence-catalog-journal.concurrency.spec.ts`, `adherence-commit-resolver.concurrency.spec.ts`: «Own history launcher required». Fallo de permisos HTTP/TLS (loopback EACCES o ejecución OpenSSL para `pool-tls`): `recaps.controller.spec.ts`, `progress.http.spec.ts`, `users.controller.spec.ts`, `progress-photos.controller.spec.ts`, `pool-tls.spec.ts`, `identity.http.spec.ts`, `rir-cycle.http.spec.ts`, `achievements.controller.spec.ts`, `client-deletion.http.spec.ts`, `adherence-config.controller.spec.ts`.

Logs locales acotados en este directorio: focused-red/green, contract-update/check-final, lint/build/prisma-generate/prisma-validate/full-unit. Los `.log` están ignorados, no se publican automáticamente; se revisaron patrones sensibles y se eliminaron rutas privadas del log global. Sin secretos ni destinos productivos usados para corregir las guardas.

## Continuación y rollback

Full suite sigue bloqueante para cierre hasta prueba equivalente aplicable. Padre confirmó motor Docker ausente: perfiles aislados obligatorios BLOCKED; runner retenido `node scripts/run-recap-review-persistence.cjs all` y perfiles concurrency/e2e/adherence-on/pg/checks no ejecutados, no PASS. No se inicia Docker ni se ejecutan wrappers. Runner existente `scripts/run-adherence-integration.cjs` exige checkout desechable sin `.env`: ON crea contenedor PostgreSQL17 tmpfs propio limitado a loopback y verifica identidad/label/puerto antes de escribir/limpiar; OFF requiere DB de prueba identificada y preparación legacy explícita. Solo recomendación: no se ha ejecutado ni reutilizado una DB/credencial ambiental.

Rollback acotado: retirar únicamente este diff de servicio, dos specs y dos contratos generados; no tocar script untracked ajeno ni datos históricos. El checkpoint raíz y seguimiento son una unidad documental separada. Pendientes: aceptación Dashboard/Admin/P5-04 navegador, medición final y decisión de slicing del padre antes de commit/PR; ninguna activación por defecto ni DONE. Espejo Engram PENDING por hook del host.