# REST-T3D-API-01a — escritores reales contra archivo

> Copia saneada para entrega: ubicaciones normalizadas; resultados, fechas y hashes conservan su significado histórico y corresponden al snapshot privado original, no a esta copia. WORKSPACE_ROOT identifica la coordinación; SDK_ROOT el SDK instalado; RUNTIME_ROOT las herramientas locales; TEST_ARTIFACT_ROOT los recursos privados retenidos, no publicados.


Cobertura añadida: `UsersService.updateRole` y `updateClientAssignments` (incluido `syncClientAssignments`) ejecutados contra PostgreSQL real, concurrentes con `setClientArchived`. **11/11 PASS; entrega parcial por TypeScript estricto de proyecto FAIL no exceptuado.** Sin defecto causal de producto demostrado ni cambio en `users.service.ts`. Revisión independiente/commit del padre pendientes; no cierre API-01/P5.

## Identidad y alcance

- Fecha: 2026-10-08 UTC. API: `${WORKSPACE_ROOT}/exom-api`, rama `feat/progreso-adherencia-p4`, HEAD/base `c080319e531fd584afabd21e5037106cb66acf10`; upstream `origin/feat/progreso-adherencia-p4`, merge-base `c383d47f4aa8217f727acf33e4c1900c0866b7bd`. Status inicial: solo probe untracked, preservado y no ejecutado.
- Coordinación EXOM sin Git utilizable según contexto del padre; no inicializada/editada. CURRENT de `odd/tasks/progress-remaining-phases.md` leído antes de escribir: 01a IN_PROGRESS, autorización P5 vigente, ENV-01 consumido intacto. CodeGraph API existente consultado con `codegraph explore updateRole`; sin init/sync ni consulta de revisión.
- Dos superficies: test existente (+220/−8; sustitución del constructor inseguro por dependencias explícitas) y este recibo nuevo. Los nueve casos originales y sus assertions se conservan. Launcher, guard, producción, probe y recursos anteriores intactos.
- RED causal: excepción de cobertura autorizada; primera ejecución de los dos casos nuevos ya PASS con producto original. No fabricar RED. El FAIL de lint posterior fue del test/instrumentación, no del producto.

## Prueba de transacción y resultado

El proxy intercepta exclusivamente `$transaction` del cliente Prisma dedicado al escritor: ejecuta íntegro el callback original, verifica su estado no confirmado, obtiene `pg_backend_pid()` y retiene esa misma transacción antes del commit mediante una promesa. No sustituye métodos de negocio, queries, locks o guards; no añade locks SQL artificiales. El archivo usa otro cliente real. La liberación ocurre **después** de observar `pg_stat_activity`, PID del escritor en `pg_blocking_pids`, consulta de lock esperada y `wait_event_type=Lock`; el polling de 10 ms solo busca esa evidencia, no decide el orden.

| Caso final | Escritor / archivo / blockers | Fila efectivamente escrita y espera | Resultado persistido |
| --- | --- | --- | --- |
| role | 75 / 73 / [75] | ADMIN de fixture pasa a CLIENT y desactiva su assignment; archivo espera `users ... FOR UPDATE` | Mensaje real de cambio de rol; rol CLIENT y assignment inactivo; archivo rechazado con `ForbiddenException` |
| assignment | 73 / 74 / [73] | Assignment exacto de fixture desactivado por `syncClientAssignments`; archivo espera `admin_client_assignments ... FOR SHARE` | Respuesta real `client_id` y `active_admins=[]`; rol ADMIN preservado y assignment inactivo; archivo rechazado con `NotFoundException` |

Antes del release, el lector externo todavía ve el assignment completo original activo. Después se compara la fila completa del cliente con su snapshot (archivo permanece false) y todas sus métricas con el snapshot previo, incluida la métrica histórica de 80 kg del fixture existente. Se compara también el assignment completo salvo el cambio esperado `is_active=false`. Finalmente se restablece exclusivamente rol/assignment propios; afterAll elimina solo los cuatro IDs de fixture en la DB nueva.

Identidad/Firebase: `IdentityService` explícito con proveedor tipado `satisfies IdentityProvider`, todos sus métodos denegados. Notifications tipado y fail-closed para cualquier método (incluidos queue/FCM); sin lifecycle Nest, AppModule ni cron. ChallengesService real ejecuta sincronización con DB estéril sin retos globales. Métricas/calendario/mail/R2 no son llamadas por estos tres caminos, no se crean proveedores de producción para ellos. El cast PrismaClient→PrismaService conserva el adaptador de DB real de la convención existente; no simula negocio ni activa lifecycle. Además, launcher existente limita TCP Node a la nueva PG y deniega HTTP/HTTPS/TLS/fetch. Esto no constituye sandbox universal de código nativo.

## Ejecuciones y recursos retenidos

Comando exacto en foreground, ambas veces: `node scripts/run-client-archive-pg.cjs`. Cada ejecución creó otra DB/volumen/contenedor nuevos, verificó ownership/SQL identity/0 tablas public antes de aplicar 92 migraciones. PostgreSQL 17 imagen `sha256:f4c66b820c6f974249089d3d16d86a3698eae11e8746eb6644b2271031e91232`; DB/user `exom_ci`, schema `public`, datadir `/var/lib/postgresql/exom-ci-data`. Dotenv estéril generado, sin credenciales heredadas ni lecturas `.env`; sin passwords/URIs en recibo. Ningún recurso eliminado/reutilizado, incluido puerto anterior 55493.

| Ejecución | UTC inicio → fin | Owner (contenedor `exom-<owner>`, volumen `exom-<owner>-data`) | Puerto loopback | SYSTEMTEMP |
| --- | --- | --- | --- | --- |
| Primera, antes de corrección de lint | 16:58:30.719 → 16:58:51.940 | `archive-1791478710717-493b53c29c52` | 57737 | `exom-archive-pg-LGBI46` |
| Final, bytes acreditados | 17:01:10.887 → 17:01:38.833 | `archive-1791478870886-fd6168725192` | 54648 | `exom-archive-pg-hIfcv5` |

Ambas: una suite, **11 passed / 0 failed / 0 skipped / 0 todo / 0 openHandles**, dos nuevos casos ejecutados nominalmente. Logs/reportes LOCAL_ONLY bajo `${RUNTIME_ROOT}/AppData/Local/Temp/`; final `manifest.json`, `9.log` (migraciones), `10.log` (wait proofs/Jest), `jest.json`. Contenedor final ID `00bb48cc0fa7d99425666f4d4c020d9f90ae47758deaba3963018f97e1fe0fea`.

## Validación y fallos sin waiver

| Comando exacto | Resultado |
| --- | --- |
| `node scripts/run-client-archive-pg.cjs` | PASS dos veces; final 92 migraciones y 11/11 sin omisiones |
| `node node_modules/eslint/bin/eslint.js src/modules/users/client-archive.concurrency.spec.ts --no-fix` | Primer FAIL: 47 formato + 2 unsafe tipos. Corrección solo test; segunda ejecución PASS, 0 diagnósticos |
| `node node_modules/prettier/bin/prettier.cjs src/modules/users/client-archive.concurrency.spec.ts` | Exit0, inspección stdout sin escritura; cambios de formato aplicados explícitamente solo al bloque nuevo |
| `node node_modules/typescript/bin/tsc --project tsconfig.json --strict --noEmit --incremental false` | FAIL exit2: DTOs sin inicializadores y tests fuera de este cambio incompatibles con sus firmas/tipos; ningún diagnóstico del test modificado. Config de proyecto más strict CLI, sin emit/buildinfo ni overwrite dist |
| `git diff --check` | PASS tracked |
| `git diff --no-index --check -- /dev/null docs/evidence/rest-t3d-api-20261008/production-client-writers.md` | Verificado al finalizar; exit1 por archivo nuevo, sin diagnósticos whitespace/EOF |

TypeScript: log íntegro LOCAL_ONLY `pi-bash-27ab58d23d507f99.log`. Ejemplos concretos: `exercises.service.spec.ts:34` TS2554; `identity.concurrency.spec.ts:57` TS2416; `metrics-overview.concurrency.spec.ts:317` TS2558; `progress.concurrency.spec.ts:454` TS2339; `users/dto/update-client-assignments.dto.ts:14` TS2564. Son rutas intactas, pero no se ejecutó comparación equivalente en base ni se recibió lista de fallos exceptuados: **no declarar fallo preexistente exceptuado ni PASS de strict**. Escalar al padre, no editar fuera de las superficies. Error de lectura auxiliar `11.log` ENOENT: índice real era `10.log`, posteriormente leído correctamente; no fallo de launcher/producto.

Build/suite completa API: NOT_RUN, tarea test/doc-only; aceptación final P5 posterior. No cambios productivos que activen build/suite por fix. No efectos externos, HTTP privacy, multirow/bulk/deletion, lock graph opuesto o histórico ampliamente poblado acreditados por esta unidad; 01b y siguientes conservan sus criterios pendientes.

## Hashes SHA256 / mismos bytes

| Archivo/artefacto | SHA256 |
| --- | --- |
| Test final (igual al manifest final) | `00a4caa19ff28c2a1493229911be1ee461c4674cff196a264346715d81e1a5a6` |
| Test primera ejecución, histórico no final | `6679dbbf501abb4128cd9db8f0cfb858fab5103dca60ee89af6476824dc5daad` |
| users.service.ts intacto | `94f360cc583391f55b10152f842b6c84cc4dd553e743a655d47aaafee5dde68b` |
| Launcher intacto | `8ddb17cf9bb139beaf5ae7fbd3b7108641dc97897328d10f5f9e0be68a60c42a` |
| Guard intacto | `a7665cbfd2181eefb6dabca14b495e2f8a3520384a260479bf34d3fe135098bd` |
| Probe original intacto | `8b5ba61a1cf147c643727dbfb2f7139126e6f08647906bb7cf5ad9004ddc8ac4` |
| Manifest final | `d6ad3a06c2aaa0cd9d5a308400ebad7e43b255279ff7573850414d34f08b5054` |
| 9.log final | `971a430ac9ac9e4544ef496175ffaf7cb12f9cfd25809b1f3d2fd70b2af22253` |
| 10.log final | `2d229ff1b35ae4ca47d842abe9fa21fe9e0785f9aa4921667dd7de67fbf6e70e` |
| jest.json final | `441a0cfba625e2b63a53ae672634bf29d529b44e01c59f6a3deeaf61711d9200` |
| Manifest primera ejecución | `073bdbbda50a4f2fc1dea577b5751fbe8536c2ce756edd4a3d2ef44839722397` |
| Log strict TypeScript FAIL | `cf5cb3ae7c7220d66f6bbbc62a9ac1a9e763b260d778ae7ea19bf8dfc206ea0f` |

Documentos vigentes intactos observados a 17:03:42.625Z: AGENTS `f21dc8259e9ff8b7a02122efd9b1651a4a22859081c6871722b099c8476a38db`; CURRENT/tarea `274510bf6fd1795764539edb127f16aa316fb23a64f57307187e302bb71f04cb`; plan `9332524f9d699412a19a9154a7a1db426c7d2688770d4cb6b5978db9d9e18a8c`. No son revisión Git de coordinación.

## Rollback y siguiente control

Unidad recuperable en diff del test + este recibo untracked; padre conserva checkpoint/revisión/commit. Rollback acotado: retirar el helper de construcción y los dos casos nuevos y recuperar constructor anterior desde base, sin alterar nueve assertions/producto/launcher/guard/probe. No ejecutar rollback ni limpieza de recursos ahora. Revisión independiente debe comprobar fidelidad del callback/locks, wait proofs y resultados por operación sobre hash final, además disponer el FAIL strict antes de cerrar 01a. No consultar/reabrir ENV-01 consumido; R3-001 permanece follow-up informacional RECONCILE separado.

## Verificación independiente posterior

Resultado final del verificador: **11/11 PostgreSQL PASS**, ESLint focal y whitespace/EOF PASS; ningún cambio mantenido. Nueva ejecución única UTC 17:24:37.259–17:25:00.949, owner `archive-1791480277258-3258669a64f9`, contenedor `exom-<owner>`, volumen homónimo `-data`, loopback53853, SYSTEMTEMP `exom-archive-pg-Zj2UMQ/{manifest.json,9.log,10.log,jest.json}`. Se acreditaron identidad/ownership/0tablas antes92migraciones; todos recursos retenidos. Role writer75→archivo73/blockers[75]/usersFORUPDATE; assignmentwriter73→archivo74/blockers[73]/assignmentsFORSHARE, ambos `Lock` observados antes release; filas completas cliente/métricas preservadas y resultados de operación comprobados. Test SHA00a4caa19f… idéntico a ejecución propia; nueve cuerpos/assertions originales idénticos a base.

Diagnóstico TypeScript separado, sin editar DTOs/config/inputs/generados ni rebajar flags:

| Opciones reales y comparación equivalente | Candidato / base | Añadidos / retirados | Estado |
| --- | --- | --- | --- |
| `tsc --project tsconfig.json --noEmit --incremental false` | 83 / 83 | 0 / 0 | FAIL, no waiver global |
| Mismo comando con `--strict` | 299 / 299 | 0 / 0 | FAIL, experimento adicional no configuración predeterminada |
| `tsc --project tsconfig.build.json --noEmit --incremental false` | 0 / 0 | 0 / 0 | PASS de build-config typecheck, no nominal Nest build |

Comandos con `node node_modules/typescript/bin/tsc`. Dos programas CompilerAPI frescos por opción compararon cada diagnóstico code/path/start/message; únicamente sustituyeron el test por su blob Gitc080319 SHA0f2dc351a18725bfb94a8a90affd11ab3e17a85a30d6a32210e17c9f7c182abb. Todos los otros inputs compilados verificados iguales, mismos deps y Prisma generado; nuevo Markdown no input. Build excluye el test y conserva 7906inputs idénticos. Prisma index.d.ts SHA49c07d13165c0efd3a4eec4f16ea06f91eaef00405777284c907c62afdc740b8. Versiones Node22.21.0/TS5.9.3/Prisma7.10.0/Jest30.3.0/ESLint9.39.4. `nest-cli.json` sin plugins.

Artefactos íntegros `${RUNTIME_ROOT}/AppData/Local/Temp/exom-01a-tsc-final-tyiYzT/`: `evidence.json`, `original-diagnostic-set.json` (83 diagnósticos/23tests intactos), `strict-diagnostic-set.json` (299), `original-cli.log`, `strict-cli.log`. `--strict` añade203 TS2564 y13 TS2345, idénticos en base. **REST-T3D-API-TSC-LEGACY-01 OPEN**, responsable API-01/RECONCILE-01/P5-FINAL: corregir o disponer individualmente los83 diagnósticos en unidad acotada, sin debilitar contratos/flags, comprobar regresiones afectadas y ejecutar el comando real. Esta prueba de no-empeoramiento y la compilación estricta sin nuevos diagnósticos acreditan únicamente la unidad de cobertura01a; no exceptúan tests críticos antiguos ni cierran criterios globales/P5. Cierre global pendiente de evaluación causal por garantía, no por recuento. El estado inicial parcial se preserva arriba como evidencia histórica.

Herramientas del verificador: quoting/BOM/package-export lookup y dos timeouts de programas combinados fallaron; artefactos retenidos, controles finales separados recuperados. No fallos del producto ni PASS ficticio. Full API suite/Nest build nominal NOT_RUN; bulk, request-deletion, histórico poblado, orden opuesto y HTTPprivacy siguen pendientes. Recibo previo a este apéndice SHA497f67cb24e4f6d3049eb871f3ed39c13aa347ef2fdc04a1f2681b69a0eaf65f ahora histórico, no hash final.
