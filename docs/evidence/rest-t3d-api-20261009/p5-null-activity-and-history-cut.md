# P5 — compatibilidad SQL NULL y corte histórico

> Copia saneada para entrega: ubicaciones normalizadas; resultados, fechas y hashes conservan su significado histórico y corresponden al snapshot privado original, no a esta copia. WORKSPACE_ROOT identifica la coordinación; SDK_ROOT el SDK instalado; RUNTIME_ROOT las herramientas locales; TEST_ARTIFACT_ROOT los recursos privados retenidos, no publicados.


Estado: PARTIAL; corrección NULL/allowlist validada, aceptación API bloqueada por cuatro fallos jobs. Sin cierre P5 ni aprobación nativa.
Fecha: 2026-10-09, Europe/Madrid. Alcance: dependencia mínima de REST-P5-FINAL / REST-T2B-FU-05. Sin P6, producción, proveedores reales, publicación ni migración remota.

## Identidad y alcance

- Coordinación: `${WORKSPACE_ROOT}/`, sin Git; plan y seguimiento existentes leídos, sin modificaciones.
- API: `${WORKSPACE_ROOT}/exom-api`; HEAD `728d90626add098427e7e19341e5ad7b15eb4ff4`, rama `feat/progreso-adherencia-p4`, upstream `origin/feat/progreso-adherencia-p4`. Diff local previo FU05 y archivos ajenos conservados. No commits nuevos.
- Se cargaron ponytail, typescript y work-unit-commits mediante sus rutas exactas (`skill_resolution: paths-injected`).
- Superficie propia: una línea SQL, dos regresiones parametrizadas en archive y dos entradas exactas de allowlist. No cambios de servicios, schema, runners ni assertions históricas.

## Causa y solución

`day_progress.meals_completed` es `TEXT[]` nullable en el esquema SQL inicial. El nuevo trigger ejecutaba `FOREACH` directamente sobre SQL NULL y PostgreSQL rechazaba inserts/updates válidos con 22004. Se limita `COALESCE(..., ARRAY[]::TEXT[])` a la expresión iterada: el valor persistido permanece NULL y no se inventan comidas ni eventos históricos. `training_completed` y `exercises_completed` son NOT NULL; la comparación `ANY(OLD.meals_completed)` con NULL no itera ni lanza 22004. No se amplía ninguna tolerancia genérica.

Las nuevas regresiones raw SQL prueban insert NULL y update de una comida acreditada a NULL; conservan NULL, dejan `challenge_activity={meals:{}}` sin entrenamiento/ejercicio/comidas acreditadas y verifican que Prisma no expone la procedencia privada. Los cuatro tests de reglas GLOBAL y todas las assertions previas permanecen.

`adherence-history-cut.pg-spec.ts` tenía un inventario posterior al corte obsoleto. Se añaden únicamente `20261005210000_add_weekly_recap_review_drafts_and_publication` y `20261009190000_p5fu05_global_challenge_eligibility_periods`, en orden. Se mantienen boundary87/corte88, allowlist exacta, checksums, procedencia y conservación; no es un defecto productivo ni una excepción de prueba.

## RED y normalización

- `node scripts/run-client-archive-pg.cjs`: RED causal **25 PASS / 2 FAIL / 0 SKIP** antes de cambiar SQL. Ambos nuevos casos fallan con `FOREACH expression must not be null`; manifest `${RUNTIME_ROOT}/AppData/Local/Temp/exom-archive-pg-QQxQYh/manifest.json`, `jest.json`, log `10.log`. PostgreSQL propio puerto65249, identidad SQL verificada, cero tablas públicas iniciales, imagen física fijada `sha256:f4c66b820c6f974249089d3d16d86a3698eae11e8746eb6644b2271031e91232`.
- Intento inicial sandbox FAIL antes de suite: `exom-archive-pg-1i6Qbl`, recurso retenido; no RED causal. Se repitió con escalación aprobada para Docker/loopback.
- GREEN intermedio **27/27**, `exom-archive-pg-gWCkg4`, después del SQL. Su assertion usaba `expect.any`, rechazado por lint `no-unsafe-assignment`; no se presenta como candidato final. Se canceló el batch y se sustituyó solo esa assertion por presencia de la clave exacta de comida previamente acreditada. Ningún proceso archive/Jest/Prisma quedó activo antes de continuar.
- `node node_modules/prettier/bin/prettier.cjs --write src/modules/users/client-archive.concurrency.spec.ts test/adherence-history-cut.pg-spec.ts`: ambos sin cambios. Solo archivos propios normalizados.
- `node scripts/run-client-archive-pg.cjs --self-check`: PASS; aceptación, siete recibos negativos y tres rechazos URL inseguros.
- `node scripts/run-recap-review-persistence.test.cjs`: PASS; imagen, entorno, selección y mínimos; recurso self-check retenido `exom-recap-self-check-UNe6Co`.
- `node scripts/run-recap-review-persistence.cjs checks`: PASS final en `docs/evidence/rest-t3a-20261005/run-checks-e1eaa379-3c20-4b7b-8f4a-a3c1dd90baff`. Prisma generate/validate, TSC `-p tsconfig.build.json --incremental false`, lint global TS `--no-fix`, `git diff --check` y `npm run build`: todos exit0. Generación anterior al freeze funcional; ningún normalizador durante los perfiles. Primera ejecución de checks conserva su FAIL real de lint en `run-checks-7b66bb4d-3a00-46f1-9efe-a478c2f14704`.

## Pins de candidato

| Archivo | SHA256 previo | SHA256 final |
| --- | --- | --- |
| migration.sql FU05 | `beced1cac41697bcd6e2e1fada5fba397533079f40f1dab9af180724bbba5400` | `8466a0bd687b47d166efd1935a99f2eb83faf5cc1484b928942d7f5aa9300f63` |
| client-archive.concurrency.spec.ts | `42f197f884ad5b3a91b211573f9722016a4aa06e2a7c806a166f87c6a04f96f6` | `d4dfd23b7b259d6880bdd8b28825e06f4e8960f7621364e784766de3c348bcc9` |
| adherence-history-cut.pg-spec.ts | `51f2ec62670b52fa76f583c36f55b7587bc92d7352ca26745e0a2a2678e54d7b` | `e6437266a2693fb641c32b22894e86348c622e39055361d0b6e6000f14a6cd09` |

Servicio retos permanece `664ee1a9d4f9a6782c0a8f102bb11ccac1eaf6dcf20a023203930c622ea74cfe`; schema `7e4cd4adad18cb812ab8e19c594435c1ab5a6b7b421bdbaa767b4ca4a5401146`; runner final `2d768c0dbe788964f55d11c60b8dde3d9001fc211b337cd540a1afb0e5c4b8e0`. Manifests before/after retienen inventario de migraciones y snapshots.

## Ejecución final

| Comando exacto | Resultado | Recibo nuevo |
| --- | --- | --- |
| `node scripts/run-client-archive-pg.cjs` | PASS27/27,0FAIL,0SKIP | `${RUNTIME_ROOT}/AppData/Local/Temp/exom-archive-pg-0hMQuF/manifest.json` |
| `node scripts/run-client-archive-pg.cjs --legacy-upgrade` | PASS27/27,0FAIL,0SKIP; rollback/recuperación/idempotencia PASS | `${RUNTIME_ROOT}/AppData/Local/Temp/exom-archive-pg-jmZfz3/manifest.json` |
| `node scripts/run-recap-review-persistence.cjs all` | FAIL1392PASS/4FAIL/0SKIP;110suitesPASS/1FAIL | `docs/evidence/rest-t3a-20261005/run-all-c1b51e51-0f8a-4887-a215-ae1fdc0d87d2` |
| `node scripts/run-recap-review-persistence.cjs adherence-on` | PASS77/77,0FAIL,0SKIP | `docs/evidence/rest-t3a-20261005/run-adherence-on-a3ad44d4-a5f8-4ef9-8a2c-0db9b38edba1` |
| `node scripts/run-recap-review-persistence.cjs concurrency` | FAIL373PASS/4FAIL/0SKIP;23suitesPASS/1FAIL | `docs/evidence/rest-t3a-20261005/run-concurrency-35197b59-6a59-4dfd-94d9-e0f6a9e625ba` |
| `node scripts/run-recap-review-persistence.cjs e2e` | PASS46/46,3suites,0FAIL,0SKIP | `docs/evidence/rest-t3a-20261005/run-e2e-c7606608-c884-44c4-a82b-72e74e627a26` |
| `node scripts/run-recap-review-persistence.cjs pg` | PASS4/4,1suite,0FAIL,0SKIP | `docs/evidence/rest-t3a-20261005/run-pg-09755b82-43b7-4262-8fbe-d9d53a4c3a5c` |

Archive final: puertos60408 limpio/60439 legacy, ambos27/27 sin open handles. Legacy conserva hash de todas las filas protegidas `f8e7d6d078642d15f0b69c50382a278c219eb9bed16110d4efc136ee3a456a9c` antes/después; rollback forzado22012 conserva filas y ausencia de tabla nueva; deploy posterior/replay conserva datos y un único backfill elegible, sin atribución de procedencia desconocida. Los manifests retienen comandos/logs, owner/image y pins finales.

El global elimina los56 fallos NULL anteriores. Persisten únicamente cuatro casos de `src/modules/jobs/jobs.concurrency.spec.ts`:
1. `P6-01: global concurrency is four across two instances`: timeout5000ms, línea396.
2. `P6-02/03: approval rollback has no event and unconfirmed execution never announces success`: notification count esperado0/recibido1, línea714.
3. `P6-03/ISSUE-061: a confirmation racing the last failed attempt remains recoverable`: esperaba `approval_approved`, recibió `streak`, línea813.
4. `P6-04: a fresh consumer recovers aggregates after producer crash, with idempotent effects`: count esperado2/recibido3, línea1246. No se afirma que sea idéntica assertion al fallo anterior de count23/24.

Todos los nombres/trazas: `jest.json` y `jest.log` del global final. No cambios, skips, excepciones ni atribución causal/base de jobs. Superficie mínima para investigar después: `src/modules/jobs/jobs.concurrency.spec.ts` (gate396-419 sin finally en timeout, fixture/limpieza114-131 y assertions714/813/1246); inspeccionar `src/modules/jobs/jobs.service.ts` solo si la reproducción aislada demuestra defecto productivo. Hipótesis de contaminación entre casos/consumo de work ajeno no confirmada, no autoriza una corrección.

Concurrency reproduce los mismos cuatro casos y assertions finales en otro cluster propio; no atribución causal establecida. Todos los cinco perfiles finales terminan con0 open handles y0 skips. La selección fija de e2e y la guarda nativa concurrency se conservaron. `all`/concurrency devolvieron exit1; el batch secuencial continuó con los perfiles independientes y terminó exit0 por `pg`, NO convierte los fallos anteriores en PASS.

Cada perfil usa un cluster nuevo propio, imagen física/propietario/mount/tmpfs/loopback/identidad SQL verificados antes de DDL; entorno estéril sin lectura dotenv, credencial solo en memoria. Recursos y evidencia retenidos, sin limpieza de clusters anteriores. Teardown de filas sintéticas limitado al propio cluster autorizado.

| Perfil | Puerto/tracking | Container ID |
| --- | --- | --- |
| all |54052/off| `07d453b3339b8f517de26fd00e461c2ff03402a2a3f285c258c3f80f30f505b1` |
| adherence-on |65160/on| `e8383474a775f64e8d9aa4e3910dce391b8bcb114ac5ed6591853f235a819b2b` |
| concurrency |54735/off| `4256dbde09c43a821bccf850f46fc38baea6c760afe163165fa522c7b4f703a9` |
| e2e |64767/off| `cbb16b85ea806141a273219cbc7182c003373bb208e87d0ee35bbfa21a942598` |
| pg |61249/on| `a89058362aa53cc5afcdd4c6a39ba5141d1c9fa31a97f96981ad034bb132d9f1` |

Los cinco perfiles usan PostgreSQL170011 e imagen física `sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0`. `resource.json` conserva nombre/owner, imagen física, tmpfs y loopback; `sql-preflight.json` acredita cero tablas públicas antes de escrituras, rol y PGDATA; `migrations.json` y `retained-databases.json` registran actualización y DB retenidas. Los seis manifests checks/perfiles before/after tienen exactamente iguales hashes fuente e inventario de migraciones. Los pins de los tres archivos propios se comprobaron nuevamente tras terminar todas las suites y coinciden con la tabla; `git diff --check` final PASS.

Readback final: ambos self-checks repetidos PASS, recurso `exom-recap-self-check-5MUDfv` retenido. Inspección de procesos propia al terminar: ningún runner archive/recap, Jest o Prisma activo. Cambio incremental propio:42 líneas de regresión,2 de allowlist y1 sustitución SQL (46 líneas autoradas código contando adiciones+borrados), más este recibo; sin reducción artificial ni cobertura eliminada.

Instantánea raíz final no-Git: AGENTS `f21dc8259e9ff8b7a02122efd9b1651a4a22859081c6871722b099c8476a38db`; plan `9332524f9d699412a19a9154a7a1db426c7d2688770d4cb6b5978db9d9e18a8c`; seguimiento `3a515a8df98fcac6d413dda3fc0b3de8d38db11c496bcfd78cc89959da511d94`. Este escritor no editó esos documentos ni Admin/App. Los cambios previos API y probe/cache originales permanecen; el nuevo recibo y la migración untracked quedan recuperables junto con las snapshots propias, sin atribuir el diff a HEAD únicamente.

## Límites y recuperación

La migración no se aplicó remotamente. Rollback local de esta unidad: retirar exclusivamente el COALESCE, las dos nuevas regresiones y las dos entradas allowlist, sin revertir la migración FU05 completa ni el trabajo anterior. Si se aplicase a otro entorno, requeriría autorización y plan propios; no se propone editar una migración ya aplicada remotamente.

Los cuatro fallos jobs finales no se atribuyen a la base ni se exceptúan. Lint directo .cjs sigue BLOCKED por projectService instalado (recibo runner previo), sin cambiar ignores ni configuración. Revisión independiente/nativa, CI y checkpoint/commit del padre pendientes. Engram: root ambiguo y sin identidad de sesión registrada; ningún write atribuido ni sesión inventada. No P5 DONE.
