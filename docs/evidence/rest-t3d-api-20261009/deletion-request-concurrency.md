# REST-T2B-FU-01 — rechazo de solicitud tras revocación de rol

> Copia saneada para entrega: ubicaciones normalizadas; resultados, fechas y hashes conservan su significado histórico y corresponden al snapshot privado original, no a esta copia. WORKSPACE_ROOT identifica la coordinación; SDK_ROOT el SDK instalado; RUNTIME_ROOT las herramientas locales; TEST_ARTIFACT_ROOT los recursos privados retenidos, no publicados.


## Alcance y estado
- Fecha: 2026-10-09; API `feat/progreso-adherencia-p4`, upstream homónimo.
- Base: `0acf025791d9b6a7c545ef444d5c506f08ec9c99`; implementación de aceptación, sin cambio productivo.
- Cláusula original: [FU-01](../rest-t2b-20261005/final-scoped-receipt.md), fila 74: invocar writers productivos completos, forzar espera y verificar autorización posterior al lock y tarea conservada.
- Esta evidencia cubre SOLO `UsersService.updateRole` → `ClientDeletionService.request`, revocación SUPER_ADMIN → CLIENT y rechazo posterior.
- R8/FU-01 sigue IN_PROGRESS: evaluación independiente, revisión nativa y checkpoint local del padre pendientes. No cierra P5 ni todas las combinaciones FU-01/03/05.
- R9/challenges poblados permanece pendiente; sin P6, publicación, despliegue ni recursos reales.

## Interleaving y protección
- Un cliente y un solicitante sintéticos nuevos; otro SUPER_ADMIN del fixture invoca `updateRole`, evitando la prohibición productiva de cambiar el propio rol.
- Rol y firma derivados del enum Prisma instalado y del método real; no SQL sustituto del writer.
- El callback productivo completo termina dentro de la transacción del writer; se verifica CLIENT y se retiene ANTES del commit.
- Otra conexión todavía lee SUPER_ADMIN; entonces comienza la solicitud real, con sus advisory de catálogo/cliente y locks ordenados originales.
- ANTES de liberar: writer PID73, solicitud PID74, `pg_blocking_pids(74)=[73]`, evento `Lock`.
- Query observada: `SELECT id FROM users WHERE id IN ($1, $2) ORDER BY id FOR UPDATE`.
- Tras liberar y confirmar el writer: el delegate real `user.findUnique` de request relee CLIENT y devuelve `ForbiddenException`; no se simula autorización ni rechazo.
- Guard instalado en la transacción de request ANTES del callback: todos los delegates `delete`/`deleteMany` y `$executeRaw`/`$executeRawUnsafe` arrojan un sentinel.
- El único SQL executeRaw alcanzable de request es DELETE de notificaciones; `user.delete` posterior queda igualmente interceptado. Si se alcanza el borde, FAIL y rollback de la transacción, incluido cualquier clientDeletion creado.
- Resultado observado: cero llamadas al guard. No se prueba una solicitud aceptada, ni se ejecuta eliminación de usuario en este caso.
- DI mediante `TestingModule.compile` instalado, providers explícitos; sin imports, AppModule, app.init, ScheduleModule ni lifecycle/registro de cron.
- Métodos de proveedores inspeccionados en sus clases: dobles de identidad/uploads y dependencias del writer arrojan al invocarse; cero llamadas externas observadas.
- Además, el preload del runner bloquea HTTP/HTTPS/TLS/fetch y TCP salvo PostgreSQL propio. Sin Firebase, R2, email, FCM, process, recover o deleteSelf.
- `finally` libera la barrera, espera ambas promesas con rechazos observados y SOLO después desconecta ambas conexiones; sin cancelaciones/query sustituto.

## Persistencia y conservación
- Fila COMPLETA del cliente idéntica antes/después; solicitante persiste CLIENT.
- Fotografía ordenada de todas las filas de las 57 tablas públicas de datos idéntica; users se verifica aparte, `_prisma_migrations` se excluye.
- Incluye tarea, métrica y notificación nuevas pobladas, además de todo el histórico existente del fixture. Tablas vacías no acreditan escenarios poblados de challenges.
- `clientDeletion`: 0 → 0; `durableWork`: 13 → 13; cero efectos externos y cero llamadas destructivas.
- Nuevas filas no pertenecen a `ids` del afterAll histórico; tarea/notificación referencian al solicitante nuevo, no a usuarios de ese teardown. Sin limpieza adicional; el afterAll original permanece intacto.
- Eliminando SOLO imports/bloque añadido, el archivo coincide byte por byte con HEAD: SHA256 `569c2ee91bd32393ad2e65917aa5e817aa5159c5cd0b45d81e7db838e0aea162`; conserva los 14 casos/imports/assertions originales.
- Los otros 23 paths de la selección anterior (19 fuentes, dos recibos sellados y FU02) siguen iguales a HEAD; agregado reconstruido de 24 pins `707f152ffc857e92101c7b1a09048b22c03c6fdbeb0c555dd20702f2d3154a37`.
- Cinco ajenos (probe y cuatro caches) estables; agregado `4ea7dca1c353be6109f1d432e2bf49b68d3b666db31d6847a4f3de81881ee420`. No se ejecutó el probe.

## Ejecución final y recursos retenidos
- `node scripts/run-client-archive-pg.cjs`: PASS, exit0, 15/15 reales, 0 FAIL/pending/TODO/open handles; 92 migraciones. UTC 13:43:05.084–13:43:22.273.
- Runner original auditado antes de ejecutar: entorno allowlist, dotenv vacío, imagen instalada sin pull, nuevo nonce/ID/volumen, RW único, PGDATA propio, puerto loopback aleatorio ≠55493.
- Pre-DDL: identidad física/labels/montaje verificados; SQL database/role `exom_ci`, directorio `/var/lib/postgresql/exom-ci-data`, public vacío (0 tablas). No fallback ni conexiones privadas.
- Owner/nonce `archive-1791553385083-4f5ec1e2e0ef`; contenedor `exom-archive-1791553385083-4f5ec1e2e0ef`, volumen con sufijo `-data`, loopback63020.
- ID `dbd03bc7d640e5fc1f33d46692d3c0e2d86658b40fe650f5023109f664c2df26`; imagen `sha256:f4c66b820c6f974249089d3d16d86a3698eae11e8746eb6644b2271031e91232`.
- Directorio de evidencia final `${RUNTIME_ROOT}/AppData/Local/Temp/exom-archive-pg-uoPTz9/`; logs completos, sin truncar artefactos.
- `manifest.json` SHA256 `124a5c0e4c7be5cf588418854a0ae5506ed6c1c9e6c2c9cc7fa95a42ef201342`.
- `jest.json` SHA256 `c664a0522c499cfbd1718474bf864142b3cc7b5206b13160e1d25e942cb8d6c2`.
- `8.log` (guard físico) SHA256 `df7e3d2e316a7ae614c5952dfa1da7ae191855113dea68dc6a22fd486e9fd25c`.
- `9.log` (migraciones) SHA256 `7f24f3bb845d459de8d13cca62e9376f44a3a1f8155307562173fdcc0348830e`.
- `10.log` (Jest/grafo/relectura) SHA256 `e22ccdf32d346c731f1222344d814980a610583214d02a43aeff0e3214dac02e`.
- Fuente final del test SHA256 `5e92b9c9f69bcd418852b65c145c7cb78bc6cec98d533f40e1cdbc147a33260c`.
- Request productivo intacto SHA256 `68faeeb29d6adb6ce8ce966ca1b221a00695f0e6f1794269cd3e7b49c17acf0d`; UsersService intacto `9abb7c05a9a58d82f6b881c1b0aff554eced150ad7eaf3acfd6fd9d0afcef232`.
- `node node_modules/typescript/bin/tsc --project tsconfig.json --noEmit --incremental false --pretty false`: PASS exit0, salida vacía, ejecución final tras el último cambio de fuente.
- `node node_modules/eslint/bin/eslint.js src/modules/users/client-archive.concurrency.spec.ts --no-fix`: PASS exit0, salida vacía, sin autofix.
- `git diff --check`: PASS exit0; revisión de conservación mediante lectura/hash, sin stage/commit del escritor.

## Límites e intentos anteriores
- RED productivo NOT_APPLICABLE: cobertura de un camino correcto; no bug/mutante artificial. GREEN de ciclo TDD no se afirma; los PASS anteriores son validación funcional.
- Primer runner `exom-archive-pg-776Urk`: FAIL exit1 antes de ejecutar casos por TS1434 del fixture (satisfies separado); manifest SHA256 `6d4ced813946fd3f9ef155802bf5810faa47a9768d84dc2b2679903d3c3d07b4`, puerto59172. No RED causal de producción.
- Primer TSC: FAIL exit2, dos TS2322 en anotaciones de barreras; primer lint: FAIL exit1, 84 errores de formato. Corregidos solo en las adiciones; salidas conservadas en la conversación, no se inventan archivos de log.
- Runners intermedios `exom-archive-pg-VcsxpI` y `exom-archive-pg-YacmNd`: PASS15/15; sus fuentes previas NO son la evidencia final. Cuatro contenedores/volúmenes y todas sus evidencias retenidos, sin Docker remove/drop schema/limpieza global.
- Dos inspecciones iniciales de hashes fallaron por sintaxis del script de lectura y ENOBUFS; repetición acotada completa PASS. Una lectura de path inexistente no modificó archivos.
- Raíz de coordinación sin Git, documentos intactos; tarea actual SHA256 `1f738275c0dc72de33d2bda2a0b140a05de3abe5ab9c589c40e6c715d914c8a0`. Admin/App no modificados ni revalidados por este escritor.
- Sin nueva suite global/build/runner; evidencia previa de Users/Nest reutilizable solo para entradas relevantes intactas, no presentada como ejecución nueva.

## Corrección acotada de cobertura — 2026-10-09
- Prefijo histórico de 62 líneas preservado íntegro, SHA256 `108402a41196015cb71f440787074f4990d96b5b4644b493e46cef19cfa59e26`; lo anterior describe la versión previa, no la aceptación actual.
- Evaluación independiente comunicada por el padre: funcional15/15 y TSC/lint/diff PASS, pero **coverage FAIL** por omitir la comparación íntegra de users. No RED productivo ni autoridad nativa/cierre.
- Recurso independiente retenido: owner `archive-1791553842726-59cc98f71e5f`, loopback56905, `exom-archive-pg-HklH44/manifest.json` SHA256 `76df0ec7f32d6994f393bd4bdf22ee974cd791fb4f3a8ca958f18c7c8fcfa7f1`; grafo writer73/request74 y guards0 válidos para esa versión previa.
- Único cambio funcional del test: `user.findMany({orderBy:{id:'asc'}})` antes del writer y después de asentar ambas transacciones; compara todas las filas/campos, longitud e IDs exactos, sin casts ni exclusión del solicitante.
- Fórmula esperada basada en `users.service.ts:373–380`: solo requester.role pasa a CLIENT; la rama que desactiva asignaciones exige rol anterior ADMIN y no aplica a este SUPER_ADMIN.
- `schema.prisma:192` declara `User.updated_at @updatedAt`: solo ese timestamp del solicitante puede cambiar. Antes de usarlo en la fórmula se exige Date válido, no retroceso frente al snapshot y pertenencia a la ventana local anterior al writer/posterior a ambas transacciones. No se enmascaran otros timestamps ni campos.
- Resultado actual: **21 → 21 usuarios**, filas/IDs/campos completos iguales salvo esos dos campos autorizados; reloj local inicio `1791554297962`, updated_at `1791554297975`, fin `1791554298028` milisegundos. Cliente completo, 57 tablas, clientDeletion0 y durableWork13 siguen intactos; guard/proveedores0.
- Grafo actual ANTES del release: writer PID74, request PID75, blockers[74], Lock, mismo SQL `SELECT id FROM users WHERE id IN ($1, $2) ORDER BY id FOR UPDATE`; tras commit relee CLIENT y ForbiddenException.
- Fuente anterior SHA256 `5e92b9c9f69bcd418852b65c145c7cb78bc6cec98d533f40e1cdbc147a33260c`; fuente actual `d208a34344289bd6016aceade30bdc18e76bffa7366616ec357c193b0cd3b6dd`. Producción, los 14 casos originales y todos los checks previos del caso permanecen intactos.
- `node scripts/run-client-archive-pg.cjs`: versión actual PASS exit0, 15/15, cero FAIL/pending/TODO/open handles, 92 migraciones; UTC13:58:00.773–13:58:18.328.
- Recurso actual retenido: owner `archive-1791554280772-5d6310d7b5fd`, contenedor `exom-archive-1791554280772-5d6310d7b5fd`, volumen sufijo `-data`, loopback63576; ID `6d73cfcc9676d5dfd58368c73b52b70db3ced2119d0408f24adb7b292cd08828`.
- Imagen fijada `sha256:f4c66b820c6f974249089d3d16d86a3698eae11e8746eb6644b2271031e91232`; runner original conserva guard físico de ownership/imagen/montaje RW y SQL exom_ci/PGDATA/public0 antes de DDL, allowlist/dotenv vacío/red restringida. Sin55493, proveedores o limpieza.
- Evidencia actual completa `${RUNTIME_ROOT}/AppData/Local/Temp/exom-archive-pg-N1dWkp/`: manifest SHA256 `986bad4c41ebb1c795c46282df8695a2a6478ce74415b4f9ede35c3927055444`; Jest SHA256 `0a4b844377cf99ca8a7db8f27bae74ebfc51fcdf44da43c69578d898d82e906c`.
- Logs actuales: `8.log` SHA256 `fa3980f2268a97e3d5086983e3a4fd1b7e0f8daffb6262cc70a0e1b0c84ef9f2`; `9.log` `635802687148ac51f9c5c2db47bbef8422ff3be927ffeadf50335993c232d687`; `10.log` `36563bfc47bb2bdfdab73e0a8b7843108b354463ad516fd908297ae98dc23884`.
- `node node_modules/typescript/bin/tsc --project tsconfig.json --noEmit --incremental false --pretty false`: versión actual PASS exit0, salida vacía.
- `node node_modules/eslint/bin/eslint.js src/modules/users/client-archive.concurrency.spec.ts --no-fix`: versión actual PASS exit0, salida vacía; primer lint de esta corrección FAIL por dos formatos, corregidos únicamente en las adiciones.
- `git diff --check`: versión actual PASS exit0. Ejecución intermedia `exom-archive-pg-XwY9w2` funcional15/15 retenida, manifest SHA256 `80595f14aeaa9735c51a4d2f40a651a5f2306742270197431f6a72b26dd7c6f7`; no sustituye los bytes finales.
- Se conserva una sola unidad/caso acotado aunque el candidato total supere 400 líneas con los recibos; no se minimizan guards/aserciones/documentación para reducir revisión. R8 sigue IN_PROGRESS, nueva evaluación independiente/revisión nativa/checkpoint del padre pendientes.

## Normalización final — evaluación independiente PASS, 2026-10-09
- Apéndice exclusivamente documental previo al freeze del padre; sin cambios de fuente, recursos, índice ni nueva ejecución funcional.
- Prefijo anterior de 82 líneas preservado byte por byte: SHA256 `21f0e6390d150515dfa910b04e3ae304acc9144f3d83a024743bccb020092e3f`.
- El padre comunica evaluación independiente **PASS** para la cobertura estrictamente acotada de este caso; resuelta la omisión de usuarios completos.
- Se conservan prospectivamente el coverage FAIL anterior y su corrección; ninguno constituye RED de un defecto productivo.
- Fuente vigente autenticada antes de este apéndice: SHA256 `d208a34344289bd6016aceade30bdc18e76bffa7366616ec357c193b0cd3b6dd`; debe permanecer igual después.
- Usuarios completos: 21 antes y 21 después, IDs exactos y todos los campos comparados; sin exclusión del solicitante ni máscaras generales de timestamps.
- Únicas diferencias permitidas: requester.role=CLIENT y su updated_at por `updateRole`/`User.updated_at @updatedAt`, conforme a las citas de fuente anteriores.
- Timestamp validado antes de incorporarlo a la fórmula: sin retroceso y `1791554297962 ≤ 1791554297975 ≤ 1791554298028`.
- Los 14 casos originales y las comprobaciones previas de guards/grafo/histórico siguen intactos; no cambió el comportamiento productivo.
- No hubo un nuevo rerun PostgreSQL independiente: se autentica y reutiliza el artefacto final del escritor ligado a la fuente vigente.
- Directorio reutilizado: `${RUNTIME_ROOT}/AppData/Local/Temp/exom-archive-pg-N1dWkp/`.
- Manifest autenticado SHA256 `986bad4c41ebb1c795c46282df8695a2a6478ce74415b4f9ede35c3927055444`; el sourceHashes del fixture coincide con la fuente actual.
- Jest autenticado SHA256 `0a4b844377cf99ca8a7db8f27bae74ebfc51fcdf44da43c69578d898d82e906c`: caso actual aprobado, 15/15 y cero FAIL/pending/TODO/open handles.
- Se reutilizan sus 92 migraciones y controles pre-DDL: `8.log` identifica imagen, ownership y montaje propios; identidad SQL exom_ci/PGDATA y public0 verificados antes de DDL.
- Recurso retenido: owner `archive-1791554280772-5d6310d7b5fd`, loopback63576; no se modificó ni limpió ningún recurso antiguo o nuevo.
- Grafo vigente anterior al release: writer74/request75, blockers[74], Lock, users con `ORDER BY id FOR UPDATE`.
- Tras commit del writer: request relee CLIENT y rechaza con ForbiddenException; no se ejecuta una solicitud aceptada.
- Cliente completo y 57 tablas de datos intactos; clientDeletion0 y durableWork13 estables; cero invocaciones destructivas o externas.
- El independiente ejecutó de nuevo TSC original, lint sin fix del fixture y diff-check: PASS exit0, fuente estable antes/después, según evidencia comunicada por el padre.
- Esos checks independientes no se repiten en esta normalización documental; tampoco se añaden builds, Nest/Users unit, runners o herramientas.
- La lectura de vuelta y diff-check documental verifican este apéndice; el pin final se entrega al padre para congelar el candidato.
- PASS limitado a esta laguna de cobertura: no acredita todas las combinaciones FU-01, borrado aceptado, challenges poblados, eliminación completa ni cierre P5.
- No se afirma aprobación nativa. R8 sigue IN_PROGRESS; revisión nativa y commit local pendientes del padre, que registrará su disposición fuera de este candidato inmutable.
