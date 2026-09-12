# Retos, logros y rachas: cálculo y recuperación

Para el cálculo de retos, logros y rachas mantengo PostgreSQL y el outbox que introduje en la fase 6. Los eventos son invalidaciones de reglas, no sumas/restas: el consumidor siempre relee la fuente canónica bajo el lock del cliente. Un evento atrasado o duplicado no revierte una corrección posterior.

| Fuente cambiada | Reglas afectadas |
| --- | --- |
| `training_completed` | TRAINING_DAYS |
| Número de comidas marcadas | MEAL_CHECKINS |
| Presencia/fecha de registro de peso | WEIGHT_LOGS |
| Actividad del día, planificación o reset | STREAK_DAYS |
| Completado de un reto | CHALLENGES_COMPLETED |
| Tipo de entrenamiento asignado | TRAINING_DAYS, incluido filtro por tipo |

Una edición de rendimiento/RIR sin cambio de actividad o completado no invalida reglas. Las variantes de comida con igual número de check-ins tampoco. En las mutaciones de catálogo/asignación menos frecuentes mantengo el recalculado completo cuando pueden cambiar ventanas o varias reglas.

Mantengo la actualización inmediata de las reglas afectadas en las peticiones de progreso y métricas. El trabajo durable se confirma con la escritura fuente y permite recuperarse si falla el paso posterior. El GET de retos/logros/racha solo lee el estado confirmado; tras un fallo post-commit puede mostrar el último resultado hasta que el worker se recupere. No inicia notificaciones ni crea una racha. Si no existe, devuelve valores cero, `id: ''`, fechas nulas y `updated_at` en epoch; App/Admin consumen los contadores. Los contadores internos de revisión no se serializan.

## Racha y concurrencia

`source_revision` lo incrementan los triggers ante cambios que afectan la actividad o planificación. `calculated_revision` identifica la revisión evaluada y `calculated_for_date` su fecha UTC de corte. El camino rápido exige revisión y fecha coincidentes, actividad previa posterior al reset y ausencia de `rebuildLongest`. `updated_at` solo indica cuándo se escribió: una reparación histórica ejecutada hoy no es un cálculo de hoy. La primera actividad, desmarcado, corrección histórica, planificación, nueva fecha o reset invalidan esa reutilización. Si una escritura SQL invalida durante el cálculo, la revisión de fuente más nueva no se sobrescribe con la revisión leída y queda trabajo durable para converger.

Mantengo este orden de locks: barrera compartida de catálogo, lock de progreso por cliente y barrera de usuario del consumidor. Reset y reparación histórica también toman el lock de progreso. En los scripts de reparación conservo el protocolo de locks de `day-progress-lock.ts`; los triggers no sustituyen la protección del comando de negocio. Las rutas habituales no envían FCM/email dentro de la transacción.

## Recalcular y reparar

Para un recalculado completo, uso `ChallengesService.recalculateAutomaticProgress`, `AchievementsService.evaluateAutomaticAchievementsForUser` y `StreakCalculatorService.recalculateClient` sin filtro. Retos y rachas aceptan `asOf` para reproducir una fecha de corte; `recalculateAllHistory(asOf)` reconstruye rachas bajo lock. Un consumidor `RECONCILE` con payload `{}` ejecuta reparación completa de las tres áreas.

Para programar una reparación autorizada de un cliente, uso `enqueueWork(tx, claveDeReparacionEstable, 'RECONCILE', {}, clientId)` en una transacción de mantenimiento identificada. Una clave estable conserva idempotencia del intento. El procedimiento de reclamación, retries, fallos definitivos y reintento está en [durable-jobs.md](durable-jobs.md). Solo aplico esta operación a datos reales con autorización para el entorno y la población afectados.

Payload optimizado: `{"version":1,"scopes":{"WEIGHT_LOGS":true}}`. La unión de invalidaciones de una transacción es atómica. `{}` domina cualquier alcance parcial. Payload legacy, versión desconocida o alcance inválido utiliza recalculado completo. Conservo las identidades de notificación/hito de la fase 6: recalcular o volver a conceder no crea otra intención para la misma identidad. Mantengo los límites de aceptación y duplicados residuales del proveedor documentados en la fase 6.

## Migración y recuperación del despliegue

Antes de arrancar esta revisión de la API, aplico `20260912120000_scoped_aggregate_work` y `20260912140000_streak_calculation_date`. Son aditivas: dos revisiones internas con valores `0/-1`, fecha de cálculo nullable (NULL invalida caché legacy), funciones y triggers; no modifican histórico, progreso, hitos ni trabajo pendiente. Después regenero el cliente Prisma desde el schema correspondiente.

Los workers antiguos pueden procesar payload v1: ignoran el alcance y recalculan completo. Los nuevos aceptan payloads antiguos. Durante despliegue mixto puede haber más trabajo, conservando deduplicación. Si tengo que volver a la API anterior, conservo las columnas y triggers aditivos; no los elimino mientras existan procesos nuevos. La reversión de código no requiere borrar datos. Si necesito revertir el DDL completo, lo preparo desde las funciones anteriores y lo valido en una copia aislada antes de ejecutarlo. No uso `migrate reset`.

Si se especifican IDs de logros y reglas afectadas, se evalúa su intersección después de validar los IDs/tipos; ningún grant ajeno al filtro se toca. Omitir ambos filtros conserva el recalculado completo.
