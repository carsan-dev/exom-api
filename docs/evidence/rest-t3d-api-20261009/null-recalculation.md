# REST-T2B-FU-05 — recálculo GLOBAL con comidas SQL NULL

> Copia saneada para entrega: ubicaciones normalizadas; resultados, fechas y hashes conservan su significado histórico y corresponden al snapshot privado original, no a esta copia. WORKSPACE_ROOT identifica la coordinación; SDK_ROOT el SDK instalado; RUNTIME_ROOT las herramientas locales; TEST_ARTIFACT_ROOT los recursos privados retenidos, no publicados.


Fecha UTC: 2026-10-09T19:12:53.356Z. Estado de esta corrección: COMPLETE; no cierra R9/P5 ni acredita despliegue.

## Causa y alcance

El lector privado de procedencia de ChallengesService proyectaba un SQL NULL legal como string[]. MEAL_CHECKINS llamaba filter y STREAK_DAYS llamaba some sobre NULL. La corrección única aplica COALESCE(meals_completed, ARRAY[]::text[]) AS meals_completed en ese SELECT compartido: cero contribución sin UPDATE, migración ni cambio del helper. No modifica semántica de baseline ni contratos públicos.

CodeGraph callers de recalculateAutomaticProgress: create/update/assign/sync de retos, reconciliación durable/jobs, métricas, reconciliación/reset de rachas y acciones/undo de progreso. Todos atraviesan el lector corregido. calculateStreak también recibe datos del lector Prisma de StreakCalculatorService, sin cambio: esta unidad solo corrige la proyección raw de procedencia GLOBAL.

Base API: 728d90626add098427e7e19341e5ad7b15eb4ff4, rama feat/progreso-adherencia-p4; diff previo preservado. Raíz de coordinación sin Git. No commits, publicación, revisión nativa, datos reales, P6 ni limpieza.

## Regresión determinista y RED → GREEN

Cuatro casos nuevos reales PostgreSQL: MEAL_CHECKINS y STREAK_DAYS, cada uno con baseline0/3. Usuarios y ámbito elegibles, periodo abierto desde ayer con opened_at de ayer, asignación de plan hoy, reto automático GLOBAL y ventana válida. Sin entrenamiento ni ejercicio completados: el flujo alcanza necesariamente la evaluación de comidas. INSERT SQL directo conserva NULL legal y procedencia vacía. Antes/después se compara fila SQL completa proyectada, asignación completa y periodo completo: ninguna actividad, ningún aumento ni pérdida del baseline.

- Intento inicial de fixture en exom-archive-pg-79BJS8: FAIL27/4 por expectativa incorrecta exercises_completed={} frente al default []; no es RED causal. Corregido a [] sin cambiar producto ni debilitar garantía.
- RED causal: node scripts/run-client-archive-pg.cjs, manifiesto ${RUNTIME_ROOT}/AppData/Local/Temp/exom-archive-pg-Az3WHQ/manifest.json; 27 PASS / 4 FAIL, TypeError filter en challenge-progress.ts:201 y some en :103. Servicio original664ee1a9…, spec RED6655e154…. Puerto50068, owner archive-1791572447815-a479d9a5e818, comando10/log10/Jest JSON retenidos.
- GREEN intermedio EjQ6aZ e iQ1jZ1:31/31. Se repite después de normalizar únicamente los110 renglones añadidos; no se atribuyen estos intermedios a los bytes finales.
- GREEN final limpio: node scripts/run-client-archive-pg.cjs, oKwBV8/manifest.json, 31/31 PASS, cero omitidos/TODO/open handles; comando10/log10. Puerto50884, owner archive-1791572623642-a4bd03f6b532.
- GREEN final legacy: node scripts/run-client-archive-pg.cjs --legacy-upgrade, JR3P3h/manifest.json, 31/31 PASS + actualización legacy, rollback, recuperación, conservación e idempotencia PASS; comando13/log13. Puerto58738, owner archive-1791572652158-1cd282f247e0.

Los tres manifiestos archive están en ${RUNTIME_ROOT}/AppData/Local/Temp/exom-archive-pg-<ID>/. Identidad física, imagen por digest, volumen propio, loopback, PGDATA, SQL y public vacío verificados antes de DDL; :55493 rechazado. Imagen archive sha256:f4c66b820c6f974249089d3d16d86a3698eae11e8746eb6644b2271031e91232. Recursos/logs/cache conservados. Un intento inicial sandbox9ecWPN no accedió a Docker; no fallback a DB existente. El runner verifica pins iniciales/finales en los dos GREEN finales.

## Comprobaciones finales secuenciales

node scripts/run-recap-review-persistence.cjs checks: PASS prisma generate/validate, TSC tsconfig.build.json, lint global TS --no-fix, git diff --check y npm run build (Nest). Comandos reales/exits/logs en el perfil checks. Prettier --check del spec final PASS; solo se formateó el bloque nuevo antes de los perfiles.

- node scripts/run-recap-review-persistence.cjs all: PASS111 suites/1404 pruebas, cero pendientes.
- node scripts/run-recap-review-persistence.cjs concurrency: PASS24 suites/381 pruebas, cero pendientes/open handles.
- node scripts/run-recap-review-persistence.cjs e2e: PASS3 suites/46 pruebas, cero pendientes/open handles.

Perfiles bajo docs/evidence/rest-t3a-20261005/; snapshots inmutables, comandos y resultados completos retenidos:

| Perfil | Estabilidad | Container ID / puerto |
| --- | --- | --- |
| run-checks-883d7c6b-71b1-4fef-aba1-4229a33e3c42 | 519 pins estables | sin DB |
| run-all-1260c650-1afc-46f6-881d-18d45e4bb40a | 519 pins estables | f0d7a3c11173b9a711c83363eff3b58a936088db7baa3433fb86c895024eaef5 / 58579 |
| run-concurrency-d1d5a989-b7bf-4090-9126-e604d90ff74e | 519 pins estables | b5a51a9cba64e0eb14b8fe786f866bcaa36bec933768442b744b333974305722 / 49155 |
| run-e2e-4055739e-fd0a-4d90-a46f-c3b85c4e4dc7 | 519 pins estables | e3a195ac986061150fbb4c712a4c66807fa920fdc297c121434b5fff12ef8ff4 / 59453 |

## Pins y recuperación

- Servicio antes:664ee1a9d4f9a6782c0a8f102bb11ccac1eaf6dcf20a023203930c622ea74cfe; después:cdc5ed8a4992f0ec499cfa0a90e9c3341e49b82af2b188355ee3b1ae015b3228. Cambio propio1 adición/1 borrado.
- Spec antes:d4dfd23b7b259d6880bdd8b28825e06f4e8960f7621364e784766de3c348bcc9; después:ca88d94e43a4da12434bc78a135f87c3e4f21ff7c469074eb8d97d8561e39c1f. Cambio propio110 adiciones, conserva los27 casos previos y todas sus assertions.
- Migración intacta:8466a0bd687b47d166efd1935a99f2eb83faf5cc1484b928942d7f5aa9300f63. Helper intacto934946d5f3c0cfebb4d15cccdd96294024194c7013e8bbe554ead6fcc2fbb8ba; StreakCalculator intacto0bdacb3a059a7ce8ea8a586f7c3e8f6654183cb8b7f9513cfe30fed02386b887.

Rollback propio: retirar exclusivamente el COALESCE del SELECT y el bloque it.each de cuatro casos, conservando todo diff previo. La extracción sin ese bloque reconstruye exactamente el hash previo del spec. Snapshots de los perfiles finales conservan los bytes ejecutados completos; este recibo nuevo no reescribe historia.

## Límites y siguiente acción

PG recap4 y adherence-on77 no repetidos en esta corrección de lectura: sus fuentes/tests/migraciones aplicables conservan hashes del recibo previo; no llaman a ChallengesService ni al lector raw corregido. Comparación completa con run-pg-09755b82-43b7-4262-8fbe-d9d53a4c3a5c y run-adherence-on-a3ad44d4-a5f8-4ef9-8a2c-0db9b38edba1: solo difieren challenges.service, cuatro specs ajenos a esos perfiles y seguimiento raíz; no se declara nuevo PASS de4/77. Admin/App no modificados ni repetidos. Lint .cjs sigue BLOCKED por exclusión projectService histórica, no cambiada.

Verificación independiente, reconciliación/cierre P5 y entrega corresponden al padre. Engram sin identidad registrada: sin mutaciones atribuidas ni sesión inventada.
