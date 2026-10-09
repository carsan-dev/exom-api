# Compatibilidad del payload publicado — API

> Copia saneada para entrega: ubicaciones normalizadas; resultados, fechas y hashes conservan su significado histórico y corresponden al snapshot privado original, no a esta copia. WORKSPACE_ROOT identifica la coordinación; SDK_ROOT el SDK instalado; RUNTIME_ROOT las herramientas locales; TEST_ARTIFACT_ROOT los recursos privados retenidos, no publicados.


Fecha: 2026-10-09. Alcance R5 / REST-T3D-RECONCILE-01, P5-02/P5-03. Solo cobertura; ninguna modificación de producto. RED productivo NOT_APPLICABLE: no defecto productivo demostrado ni comportamiento esperado inventado.

La publicación `reviewed_at=2026-10-08T10:20:30.456Z` se conserva ante un borrador privado posterior (`updated_at=2026-10-09T11:00:00.000Z`, versión9). Cuatro sentinelas distintos para nota interna/resumen/cambios/objetivos privados. Feedback legacy con fecha de envío sigue permitido; nunca se usa el borrador como fallback. Null/ausencia no inventan publicación. Tests anteriores de privacidad, identidad y sesión conservados.

| Variante | Campos públicos | SHA256 JSON canónico |
| --- | --- | --- |
| full | 42 | b259648472dff52f42fbc0cc4960ab980542023d1813222b6ca70219ad1bb238 |
| partial | 42 | 1eed7dd846aded5b022cb90e654cdee9be5708bf3d361b8d40815b23841eeaea |
| null | 42 | 3789f1f9081af01410a44865040cd837667be56f8e3b7665fb1804c09bf4b6aa |
| absent legacy | 39 | 6c34850dd3feafdedd5adb4fa873c1cf052deef0bb1f2d791935ffd69ebab837 |

Comparación estructural de los tres literales PASS: extraer `publicationPayload`, interpretar claves/valores sin tipos y comparar objetos; JSON canónico UTF-8, claves ordenadas, separadores compactos, Unicode sin escape. Variantes idénticas: tres textos; resumen/NULL/objetivos; tres NULL; eliminación de las tres claves. Cada checkout incorpora su literal; los tests no leen archivos hermanos ni requieren fixture externo.

Snapshot base HEAD728d90626add098427e7e19341e5ad7b15eb4ff4; rama/upstream feat/progreso-adherencia-p4 / origin/feat/progreso-adherencia-p4, sin cambios de rama. SHA256 spec `d8c64630fdda9da99293c3974f596c8e90cb79c3eaa4b8555a37ff838b604745`.

- PASS `node node_modules/jest/bin/jest.js --runInBand src/modules/recaps/recaps.service.spec.ts`:29/29. Cuatro variantes pasan por select real de servicio, mock Prisma respetando select, fechas Date nativas y JSON detail/list; ausencia simula respuesta legacy, no una base sin columnas.
- PASS `node node_modules/typescript/bin/tsc --noEmit` y ESLint no-fix de los dos specs propios.
- PASS `node scripts/run-recap-review-persistence.cjs all`:111 suites/1400 tests,0 FAIL/SKIP/pending/openhandles. PG17 propio62718/tmpfs, identidad física imageID y SQL verificadas antes de DDL. Entorno estéril, red externa/dotenv prohibidos. Manifest fuente/migraciones antes/después idéntico.
- Evidencia final `docs/evidence/rest-t3a-20261005/run-all-38279194-b94c-40db-80f8-3692ad48d060`: `jest.json`, `jest.log`, `resource.json`, `sql-preflight.json`, `manifest.json`, `manifest-after.json`; recursos retenidos sin limpieza/apagado.
- PASS `git diff --check` tres repos. Node22.21.0/npm11.13.0, Prettier3.8.1; no dependencias/lockfiles añadidos.
- Históricos no finales: intento aislado5fcb63d3 bloqueado por Docker; run27c21a04 PASS1400 pero supersedido por recuperación UTF-8. Runf5225b59 final entonces1393PASS/7FAIL, cinco timeouts5000 y dos fallos posteriores en multipart/aggregates, durante checks globales simultáneos; logs retenidos, causa no afirmada. Repetición secuencial final38279194 PASS1400 sin editar producto/tests/timeouts/assertions.
- Incidente propio recuperado: escritura Python con encoding implícito produjo mojibake y normalización LF truncó Admin/App. Recuperación limitada a cuatro tests inicialmente limpios y diff propio, desde HEAD/bytes verificados. Sin checkout/reset ni archivos ajenos. Resultados previos supersedidos; ninguna assertion debilitada.

SKIPPED: build API (inputs de producto/build sin cambio; no nuevo PASS declarado), migraciones/e2e/concurrency dedicadas ya acreditadas sobre fuentes productivas idénticas no repetidas por rutina; sin liveFirebase/JWT/device/iOS/producción ni P6. Revisión independiente/nativa y CI corresponden al padre, no acreditadas aquí.
