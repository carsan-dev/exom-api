# Normalización del esquema Prisma sin cambio funcional

Criterio: REST-P5-CI-FORMAT-01. Corrige el fallo observado del CI final P5 en `prisma:format:check`, sin modificar el checker ni criterios.

## Causa y cambio mínimo

Prisma 7.10.0 normaliza el campo ignorado `BodyMetric.challenge_activity_at` colocando `@ignore` antes de `@db.Timestamptz(3)`. El guard existente distingue ese orden de tokens y rechazaba el esquema. También faltaba alineación canónica en WeeklyRecap. Se conserva el campo ignorado, su tipo/default y anotación nativa; el resto del cambio es alineación canónica del esquema completo.

## Verificación local — 2026-10-10

- RED observado sobre los bytes del nuevo worktree, con el checker byteexacto y Prisma 7.10.0 instalado: exit1, `Formatting changed schema tokens; inspect before writing`.
- GREEN con el mismo checker byteexacto sobre los bytes normalizados: exit0, `Prisma schema format PASS; source unchanged`; normalización canónica/idempotente.
- PASS: `prisma validate` con config propia sin dotenv, URL local placeholder sin conexión ni recursos DB. No se leyó configuración real ni secretos; no se instalaron dependencias.
- PASS: comparación léxica completa preservando literales y eliminando solo whitespace/comentarios para la comparación, admitiendo exclusivamente la conmutación explícita de atributos del campo indicado. Comentarios y declaraciones completos también iguales. DMMF NOT_AVAILABLE: internals no instalado; no se presenta equivalencia DMMF como PASS.
- PASS: inventario completo paths/modes/blobs; únicamente esquema y este recibo cambian. Migraciones SQL, modelos, campos, relaciones, índices, maps, defaults, tipos, workflow, checker, contratos y locks preservados.
- CI remoto del nuevo commit NOT_RUN/PENDING de publicación; resultados anteriores y revisión de otro candidato no lo acreditan.

## Rollback y límites

La reversión se limita al formato del esquema y este recibo; reintroduciría el fallo de formato observado. No incluye migraciones, DB, runtime ni generación de contratos. Suites completas y DB NOT_RUN por ser corrección de formato; CI exacto debe ejecutarse posteriormente antes de merge. Evaluación nativa se registra después del commit; este recibo no declara aprobación.
