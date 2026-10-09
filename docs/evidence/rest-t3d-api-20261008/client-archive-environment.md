# REST-T3D-API-ENV-01 — archive PostgreSQL aislado

> Copia saneada para entrega: ubicaciones normalizadas; resultados, fechas y hashes conservan su significado histórico y corresponden al snapshot privado original, no a esta copia. WORKSPACE_ROOT identifica la coordinación; SDK_ROOT el SDK instalado; RUNTIME_ROOT las herramientas locales; TEST_ARTIFACT_ROOT los recursos privados retenidos, no publicados.


Launcher local implementado y smoke real **PASS: 9/9**, sin cambios de producto ni del fixture. Esto acredita infraestructura y la suite existente; **no cierra API-01/P5**, ni demuestra writers opuestos de producción, histórico completo o privacidad HTTP. Verificación independiente PASS registrada abajo; revisión nativa y commit local pendientes al registrar este recibo.

## Reproducir

```sh
node --check scripts/run-client-archive-pg.cjs
node scripts/run-client-archive-pg.cjs --self-check
node scripts/run-client-archive-pg.cjs
```

Cada ejecución crea recursos nuevos, conserva todo y exige Docker activo e imagen `postgres:17` ya cacheada. No instala, descarga, genera Prisma, compila ni arranca AppModule/Cron. El informe exige una suite, >=9 assertions realmente pasadas, cero failed/pending/todo y cero open handles; timeout/error/omisión devuelve exit no cero.

## Resultado observado — 2026-10-08 UTC

| Check | Resultado |
| --- | --- |
| `node --check scripts/run-client-archive-pg.cjs` | PASS, versión final |
| `node scripts/run-client-archive-pg.cjs --self-check` | PASS: aceptación + 7 informes negativos + 3 URLs inseguras rechazadas |
| `node scripts/run-client-archive-pg.cjs` | PASS exit0, 16:30:13.573Z–16:30:51.792Z |
| Prisma `migrate deploy` instalado | PASS exit0; 92 migraciones sobre DB nueva vacía |
| Jest focal instalado | PASS exit0; 1 suite / 9 tests; failed/skipped/todo/openHandles = 0 |
| `git diff --check` | PASS exit0 |
| `git diff --no-index --check -- /dev/null scripts/run-client-archive-pg.cjs` | Sin diagnósticos whitespace/EOF; exit1 esperado por archivo nuevo |
| `git diff --no-index --check -- /dev/null docs/evidence/rest-t3d-api-20261008/client-archive-environment.md` | Sin diagnósticos whitespace/EOF; exit1 esperado por archivo nuevo |

Comandos internos exactos no secretos y resultados: `manifest.json`, entradas9–10. Node instalado `${RUNTIME_ROOT}/node js/node.exe`; Prisma `node_modules/prisma/build/index.js migrate deploy`; Jest `node_modules/jest/bin/jest.js --runInBand --no-cache --runTestsByPath src/modules/users/client-archive.concurrency.spec.ts --detectOpenHandles --json --outputFile <TEMP>/jest.json --cacheDirectory <TEMP>/jest-cache`. `<TEMP>` es el directorio absoluto siguiente; el manifiesto conserva los argv concretos.

## Recursos y evidencia conservados (LOCAL_ONLY)

- TEMP final: `${RUNTIME_ROOT}/AppData/Local/Temp/exom-archive-pg-IORNXt`; `manifest.json`, logs `1.log`–`10.log`, `jest.json`, dotenv vacío y preload de bloqueo de red. Sin URI/password en recibo/logs.
- Owner/label: `exom.archive.owner=archive-1791477013572-e71a3cff33cc`.
- Container: `exom-archive-1791477013572-e71a3cff33cc`; ID `3a3f3480318f3d121340f545ac31fcf4fbe3b85889c781df423add9cc9ce3c5d`.
- Volumen nuevo: `exom-archive-1791477013572-e71a3cff33cc-data` (mismo label).
- Imagen efectiva: `sha256:f4c66b820c6f974249089d3d16d86a3698eae11e8746eb6644b2271031e91232`, usada por ID con `--pull never`.
- Puerto: exclusivamente `127.0.0.1:64275`; DB/rol `exom_ci`; PGDATA `/var/lib/postgresql/exom-ci-data`. SQL confirmó los tres valores antes de migrar; tablas public iniciales0.
- Imagen17 declara `/var/lib/postgresql/data`: tmpfs explícito lo cubre, evitando volumen anónimo adicional. Docker expone tmpfs en `HostConfig.Tmpfs`, no en `Mounts`; ambos se verifican.

Fallos reales anteriores conservados, no reclasificados como PASS:

| UTC / TEMP | Fallo y límite alcanzado |
| --- | --- |
| 16:28:57.012Z–16:28:59.171Z / `exom-archive-pg-G9dEOE` | Mount mismatch por buscar tmpfs en Mounts; no migraciones/fixtures. Container `exom-archive-1791476937011-87309ec7b472`, volumen mismo nombre + `-data`, puerto55167, ambos retenidos |
| 16:29:30.399Z–16:29:35.949Z / `exom-archive-pg-NYGZdQ` | Node preload MODULE_NOT_FOUND: NODE_OPTIONS interpretó backslashes Windows. SQL identity/vacío PASS, Prisma no arrancó; sin fixtures. Container `exom-archive-1791476970398-a8fe8ee4311b`, volumen + `-data`, puerto54149, ambos retenidos |

Correcciones: metadata tmpfs explícita y ruta preload con barras `/`. Cada reintento creó recursos nuevos; no se reutilizó ninguno.

## Identidad y preservación

API raíz `${WORKSPACE_ROOT}/exom-api`, rama `feat/progreso-adherencia-p4`; HEAD/base `2860703d8e00dc6a096a02c0c4b37543c0cd514a`; upstream `origin/feat/progreso-adherencia-p4`, merge-base `c383d47f4aa8217f727acf33e4c1900c0866b7bd`. Estado inicial: únicamente probe untracked. Coordinación `${WORKSPACE_ROOT}/`; CURRENT leído sin cambios, no operaciones RootGit/otros repos/CodeGraph init o sync.

| Fuente | SHA256 |
| --- | --- |
| Launcher probado | `8ddb17cf9bb139beaf5ae7fbd3b7108641dc97897328d10f5f9e0be68a60c42a` |
| Fixture unchanged | `0f2dc351a18725bfb94a8a90affd11ab3e17a85a30d6a32210e17c9f7c182abb` |
| Guard unchanged | `a7665cbfd2181eefb6dabca14b495e2f8a3520384a260479bf34d3fe135098bd` |
| Probe original preservado/unrun | `8b5ba61a1cf147c643727dbfb2f7139126e6f08647906bb7cf5ad9004ddc8ac4` |

Otros hashes fuente/setup/config/package están en manifest. Las migraciones son las del HEAD, sin cambios. Strict RED de producto NOT_APPLICABLE: infraestructura sin defecto de producto demostrado; checks deterministas y smoke son evidencia funcional, no RED artificial.

## Seguridad, rollback y límites

Entorno hijo allowlist de variables OS/tooling, sin heredar credenciales/hooks; dotenv apunta a fichero TEMP vacío y aliases TEST_DATABASE_URL/DATABASE_URL/PRISMA_DATABASE_URL explícitos. Password aleatorio solo por env de proceso/Docker (Docker conserva ese secreto en su configuración: no inspeccionar Config.Env para recibos). No fallback de producción. Guard existente reutilizado sin parches; verifica URL y SQL antes de migraciones y de fixtures. Fixture conserva todos los casos/assertions y solo borra sus IDs propios. `IdentityProvider` no tiene efectos en construcción; no fue necesario sustituirlo. Preload permite únicamente TCP hacia ese PG y rechaza HTTP/TLS/fetch; no sustituye al guard de DB ni constituye sandbox universal de procesos nativos.

## Verificación independiente — 2026-10-08 UTC

Ejecutados de nuevo `node --check scripts/run-client-archive-pg.cjs`, `node scripts/run-client-archive-pg.cjs --self-check` y `node scripts/run-client-archive-pg.cjs`: PASS sin reparación ni retry. Ventana `16:35:52.169Z–16:36:12.862Z`; 92 migraciones, una suite, nueve assertions PASS, cero failed/skipped/todo/runtime-errors/open-handles. Guard/fixture/launcher permanecen en los hashes anteriores. Ambos checks Git de archivo nuevo no produjeron diagnósticos; exit1 representa diferencias nuevas, no fallo whitespace.

Nuevo recurso independiente: owner `archive-1791477352168-0f491a5ab6f8`, container `exom-archive-1791477352168-0f491a5ab6f8`, ID `8374c5f1bbdd37447f08aee81a663a8a1101e114f78a66b8986e1480004535bf`, volumen homónimo `-data`, binding `127.0.0.1:49562`; misma imagen fijada por SHA. SQL confirmó DB/rol `exom_ci`, datadir esperado y cero tablas public antes de migrar; volumen/label/tmpfs verificados. Recursos retenidos, sin modificar los anteriores.

Manifest/argv concretos, logs `1.log`–`10.log` e informe `jest.json` conservados en `${RUNTIME_ROOT}/AppData/Local/Temp/exom-archive-pg-X2HsTT` (LOCAL_ONLY). `connection.private.env` tiene herencia eliminada y acceso current-user/SYSTEM; no se expone su contenido. API HEAD/base sin cambios, inventario dos rutas nuevas más probe original intacto. Pruebas amplias y garantías de writers opuestos/histórico/privacidad siguen NOT_RUN. Esta adición solo documental no invalida los bytes del launcher probado.

Rollback de código limitado a los dos archivos nuevos. No parar/eliminar recursos automáticamente: cualquier limpieza futura requiere autorización separada sobre nombres/labels exactos. Contenedor previo `exom-p4-t1-ci-20260928`/55493 no conectado/reutilizado/parado; ninguno de los recursos previos fue alterado. TEMP/logs son locales, no evidencia recuperable desde fresh clone; launcher sí es reproducible. No pruebas amplias, oposición de writers reales, integración móvil/Admin, privacidad/histórico completo, revisión nativa, staging/commit/push ni despliegue en esta unidad.
