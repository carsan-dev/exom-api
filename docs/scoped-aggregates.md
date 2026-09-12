# Retos, logros y rachas: cálculo y recuperación

Fase 7 mantiene PostgreSQL y el outbox de Fase 6. Los eventos son invalidaciones de reglas, no sumas/restas: el consumidor siempre relee la fuente canónica bajo el lock del cliente. Un evento atrasado o duplicado no revierte una corrección posterior.

| Fuente cambiada | Reglas afectadas |
| --- | --- |
| `training_completed` | TRAINING_DAYS |
| Número de comidas marcadas | MEAL_CHECKINS |
| Presencia/fecha de registro de peso | WEIGHT_LOGS |
| Actividad del día, planificación o reset | STREAK_DAYS |
| Completado de un reto | CHALLENGES_COMPLETED |
| Tipo de entrenamiento asignado | TRAINING_DAYS, incluido filtro por tipo |

Una edición de rendimiento/RIR sin cambio de actividad o completado no invalida reglas. Las variantes de comida con igual número de check-ins tampoco. Las mutaciones de catálogo/asignación menos frecuentes conservan fallback completo cuando pueden modificar ventanas o varias reglas.

Las peticiones de progreso y métricas mantienen actualización inmediata de sus reglas afectadas. El trabajo durable se confirma con la escritura fuente y permite recuperarse si falla el paso posterior. El GET de retos/logros/racha solo lee el estado confirmado; tras un fallo post-commit puede mostrar el último resultado hasta que el worker se recupere. No inicia notificaciones ni crea una racha. Si no existe, devuelve valores cero, `id: ''`, fechas nulas y `updated_at` en epoch; App/Admin consumen los contadores. Los contadores internos de revisión no se serializan.

## Racha y concurrencia

`source_revision` lo incrementan los triggers ante cambios que afectan la actividad o planificación. `calculated_revision` identifica la revisión evaluada y `calculated_for_date` su fecha UTC de corte. El camino rápido exige revisión y fecha coincidentes, actividad previa posterior al reset y ausencia de `rebuildLongest`. `updated_at` solo indica cuándo se escribió: una reparación histórica ejecutada hoy no es un cálculo de hoy. La primera actividad, desmarcado, corrección histórica, planificación, nueva fecha o reset invalidan esa reutilización. Si una escritura SQL invalida durante el cálculo, la revisión de fuente más nueva no se sobrescribe con la revisión leída y queda trabajo durable para converger.

Se conserva el orden del sistema: barrera compartida de catálogo, lock de progreso por cliente y barrera de usuario del consumidor. Reset y reparación histórica también toman el lock de progreso. Los scripts de reparación de fuentes deben conservar el protocolo de locks de `day-progress-lock.ts`; los triggers no sustituyen la protección del comando de negocio. Las rutas habituales no envían FCM/email dentro de la transacción.

## Recalcular y reparar

Se conservan `ChallengesService.recalculateAutomaticProgress`, `AchievementsService.evaluateAutomaticAchievementsForUser` y `StreakCalculatorService.recalculateClient` sin filtro para recalculado completo. Retos y rachas aceptan `asOf` para reproducir una fecha de corte; `recalculateAllHistory(asOf)` reconstruye rachas bajo lock. Un consumidor `RECONCILE` con payload `{}` ejecuta reparación completa de las tres áreas.

Para programar reparación de un cliente autorizado, usar el mecanismo existente `enqueueWork(tx, claveDeReparacionEstable, 'RECONCILE', {}, clientId)` en una transacción de mantenimiento identificada. Una clave estable conserva idempotencia del intento. Ver reclamación, retries, fallos definitivos y reintento operativo en [durable-jobs.md](durable-jobs.md). No aplicar esta operación a datos reales sin autorización de entorno y población.

Payload optimizado: `{"version":1,"scopes":{"WEIGHT_LOGS":true}}`. La unión de invalidaciones de una transacción es atómica. `{}` domina cualquier alcance parcial. Payload legacy, versión desconocida o alcance inválido utiliza recalculado completo. Las identidades de notificación/hito de Fase 6 se conservan: recalcular o volver a conceder no crea otra intención para la misma identidad. Se mantienen los límites de aceptación/duplicados residuales del proveedor de Fase 6.

## Migración y recuperación del despliegue

Aplicar `20260912120000_scoped_aggregate_work` y `20260912140000_streak_calculation_date` antes de arrancar esta revisión de la API. Son aditivas: dos revisiones internas con valores `0/-1`, fecha de cálculo nullable (NULL invalida caché legacy), funciones y triggers; no modifican histórico, progreso, hitos ni trabajo pendiente. El cliente Prisma se regenera desde el schema correspondiente.

Los workers antiguos pueden procesar payload v1: ignoran el alcance y recalculan completo. Los nuevos aceptan payloads antiguos. Durante despliegue mixto puede haber más trabajo, conservando deduplicación. Para volver a la API anterior, conservar las columnas y triggers aditivos; no eliminarlos mientras existan procesos nuevos. La reversión de código no requiere borrar datos. La reversión de DDL completa debe prepararse desde las funciones anteriores y validarse en una copia aislada antes de ejecutarse; no usar `migrate reset`.

Si se especifican IDs de logros y reglas afectadas, se evalúa su intersección después de validar los IDs/tipos; ningún grant ajeno al filtro se toca. Omitir ambos filtros conserva el recalculado completo.

Evidencias reproducibles y límites de coste: raíz de coordinación `docs/operations/phase7-20260912/WORK.md` (cierre inicial) y `docs/operations/phase7-review-20260912/WORK.md` (revisión y correcciones), mediciones SQL/Prisma, pruebas PostgreSQL, migraciones fresh/upgrade/rollback y checkpoints con hashes. No equivalen a despliegue.
