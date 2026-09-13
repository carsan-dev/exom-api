# Inventario legacy — Fase 10

Revisión exclusiva: 2026-09-13; base API b90cc4f, Admin 2599e1e, App 06de9ed. Resultado y hashes: `../../docs/operations/phase10-review-20260913/final/manifest.json`. Autoridad de decisiones: [ADR-001/025/026](../../REMEDIATION.md). No se retira ningún campo ni se ejecuta un backfill remoto en esta fase.

## Asignaciones: modelo canónico y consumidores

`plan_assignment_trainings` y `auto_assignment_rule_day_trainings`, ordenados por `position`, son la representación canónica múltiple. `training_id` es el espejo del primer enlace; una fila realmente sin enlaces conserva el fallback escalar. `training_ids` es una proyección de transporte. Las reglas son fuente de la planificación automática; una asignación materializada no demuestra por sí sola intención manual ni procedencia histórica fiable.

| Representación | Escritores y entradas inspeccionados | Lectores y compatibilidad |
| --- | --- | --- |
| Asignación diaria | `src/modules/assignments/assignments.service.ts`: bulk, batch, copia de día/semana, creación, actualización parcial, eliminación/override vacío; `assignment-input.ts` normaliza todos los formatos. `auto-assignment-materializer.service.ts` materializa y reconcilia. | El mismo servicio serializa lista/día/semana; `trainings.service.ts` resuelve hoy/día, catálogo y detalle; `calendar.service.ts` expone días; endpoints de progreso de cliente en `users.service.ts` consumen el contexto. Los lectores prefieren enlaces y conservan fallback escalar. |
| Regla automática | Creación/edición/copia en `assignments.service.ts`; materializador solo escribe resultados, no inventa reglas. DTOs `auto-assignment-rule`, `bulk-assign`, `batch-assign-days`, `update-assignment`, `assignment-training-input`. | Materializador por ventanas, GET de planificación documentados, calendario, scheduler de notificaciones; filtros de catálogo activo se aplican al futuro, no a asignaciones históricas protegidas. |
| Espejos e histórico | SQL `20260904120000_sync_legacy_assignment_training_mirrors`; SQL73/74 `timed_prescriptions`/`timed_feedback_history`; RIR `20260909120000_client_rir_mesocycle`. Migración inicial múltiple `20260804120000_multiple_trainings_per_day`; seeds/fixtures y `src/scripts/repair-plan-edit-progress.ts` también inspeccionados. | Triggers de enlaces sincronizan escalar. Los triggers BEFORE de asignación capturan prescripción histórica usando el escalar inicial antes de insertar hijos. El escalar inicial en comandos actuales es necesario: quitarlo sin sustituir esa captura perdería histórico. |
| Progreso y efectos derivados | `progress.service.ts`, feedback/LAST_SET, reparación explícita, servicios de borrado de cliente; agregados y jobs no son fuentes de planificación. | `common/progress/training-history.ts`, contexto de progreso, feedback, rachas, logros, calendario y `notifications-scheduler.service.ts`. Conservan identidad de ocurrencia cuando existe y no atribuyen una ambigua. |
| Admin | `src/features/assignments/api.ts`, `schemas.ts`, `types.ts`, `assignment-editor-state.ts`, `assignment-editor-dialog.tsx`, `assignments-page.tsx`: envían lista canónica con políticas y espejos compatibles. | Formulario, tarjeta de día y duplicado recuperan lista o scalar antiguo. `features/trainings/api.ts` normaliza prescripciones. No se cambia su dominio/UI por DTOs generados. |
| App y cola persistida | `features/trainings/data/models/training_model.dart` lee respuesta; `core/services/offline_sync_service.dart`, `pending_progress_overlay.dart`, datasource/cola de feedback escriben progreso y evidencias, no reglas. | Las versiones instaladas pueden recibir scalar, prescripción textual o segundos sin `timed_config`, y conservar operaciones antiguas durante desconexión indefinida. HEAD de App y sus formatos Hive/cola no cambian. |

El orden de entrada existente se conserva: `trainings` explícito, después `training_ids`, después `training_id`; lista vacía explícita no significa campo omitido. Máximo cinco, sin duplicados; descanso vacía planes; al editar se conservan campos omitidos. `last_set_video_policy` es canónico; `requires_last_set_video` sigue aceptado/serializado para compatibilidad, con resolución contextual AUTO. No convertir AUTO en un booleano global.

La normalización de comandos ya estaba centralizada en un método: esta fase extrae esa responsabilidad sin cambiar su cuerpo. No repite una migración de escritores/lectores que los triggers, los normalizadores y las pruebas ya acreditan. Tampoco elimina las escrituras escalares necesarias para la captura histórica.

## Backfill preparado y verificado

`src/modules/assignments/legacy-assignment-backfill.ts` exporta una operación explícita dentro de una transacción del llamador. Inserta únicamente el enlace inequívoco del escalar existente, de un propietario concreto, con entrenamiento referenciado existente (aunque esté retirado), sin enlaces y sin descanso. No toca la regla de origen, progreso JSON, ocurrencias, snapshots ni políticas canónicas existentes. En días de regla, AUTO/false conserva el fallback del materializador. En asignación diaria, SQL75 añade `legacy_video_exempt`, false por defecto y true solo para enlaces del backfill: conserva ausencia de obligación de vídeo y exclusión del primer día que determina la semana mensual. El reconciliador excluye esos enlaces; edición explícita y copia crean enlaces normales. El materializador trata un enlace exento como representación legacy y lo reemplaza cuando la regla gobierna una fecha futura mutable; conserva pasado/hoy iniciado. La marca es interna y no aparece en las respuestas HTTP. Filas de descanso contradictorias y referencias ausentes quedan fuera; requieren diagnóstico, nunca adivinación.

ISSUE-073 corrigió la afirmación anterior de que AUTO/false bastaba: la reconciliación posterior podía exigir vídeo al legacy y quitar la obligación a otro entrenamiento. ADR-026 sustituye solo esa afirmación, sin cambiar la fuente de verdad de ADR-001.

Cada llamada limita a 100 asignaciones y 100 días de regla; puede repetirse hasta ambos contadores cero. Comparte orden global de histórico → advisory del cliente → fila del usuario → filas de planificación; `ON CONFLICT DO NOTHING` complementa el lock y los constraints. No es un job al arrancar ni una migración automática.

Antes de aplicar fuera del recurso desechable se requiere autorización de entorno y población, identidad real del destino, recuento solo lectura, copia recuperable de padres/enlaces y políticas, y transacción por propietario. Comparar antes/después los padres, historial/progreso y primer espejo; rollback antes de commit ante discrepancia. Tras un commit no borrar enlaces a ciegas: si hubo escritores posteriores, restaurar solo con diagnóstico y exclusión concurrente; preservar copia y registrar IDs fuera de logs públicos. Una respuesta perdida se resuelve reejecutando, sin duplicar enlaces.

Evidencia nueva: `legacy-assignment-backfill.concurrency.spec.ts` usa PostgreSQL17 real, verifica DB/rol/data_directory antes de escribir y conserva fixtures con escalar histórico/progreso sin ocurrencia, catálogo retirado, propietario, rollback y replay. Fuerza espera en `pg_locks` tras escritor y comprueba su política NEVER. Añade dos regresiones rojas/verdes de obligaciones mensuales (fila canónica antes/después del backfill) y una de rematerialización futura frente a pasado protegido. SQL75 `20260913150000_preserve_legacy_video_policy` probado como actualización74→75, conservación/default false y rollback de DDL; las75 migraciones también se aplicaron a una DB inicialmente vacía identificada. Evidencias en phase10-review-20260913. No hay backfill de datos reales acreditado.

Orden de despliegue futuro, sujeto a autorización independiente: SQL75 aditivo → todas las instancias/jobs API con el reconciliador actualizado → backfill explícito por población autorizada. No aplicar backfill durante mezcla de versiones: un API antiguo ignoraría la exención y alteraría políticas. La aplicación antigua puede convivir con la columna mientras no haya filas exentas. Si ya existen, no volver a un reconciliador antiguo ni eliminar la columna; mantener el nuevo código o preparar restauración acotada/revisada desde copia, bajo locks y verificando escrituras posteriores. El rollback transaccional previo al commit ya está probado; restauración remota posterior no está ejecutada ni implícitamente autorizada.

## Contratos temporales y otras duplicidades conservadas

| Campo/formato | Fuente y transición segura |
| --- | --- |
| `reps_or_duration` frente a `measure_type`, `target_value`, min/max | Prescripción estructurada en segundos/reps; parser legacy mantiene texto y rangos. La extracción `exercise-prescription.ts` conserva los resultados y errores anteriores. No eliminar el texto mientras lectores instalados lo usan. |
| `timed_config` v1 | ADR-024: unidad de presentación y acciones ordenadas; segundos canónicos. Omitido conserva, null elimina. Intervalos requieren total exacto SECONDS; rango admite presentación sin segmentos. Se repiten/recortan al total; no cambian descanso ni segundos realizados. |
| Histórico temporal / LAST_SET | SQL73 captura antes de cambios; SQL74 considera el primer LAST_SET aunque falte progreso normal y conserva ejercicio/prescripción/ocurrencia. No reconstruye IDs destruidos antes de su implantación. |
| Texto legacy de intervalos | API incluye instrucciones completas en `exercise.explanation_text`; versiones antiguas siguen mostrando total/acciones aunque no tengan temporizador nuevo. App conserva segundos/RIR/identidad al persistir y reintentar. |
| RIR objetivo frente a RIR realizado | Ciclo/versiones/overrides por ocurrencia determinan objetivo; progreso por serie registra lo realizado. Omitir no borra. `training_exercise_id` ausente no se rellena si hay más de una ocurrencia posible. |
| `exercises` frente a `items`/circuitos | Adaptadores conservan circuito, orden e identidad; duplicación de entrenamiento renueva IDs, edición los mantiene. Refactor del formulario no modifica esa regla. |

F007-01..07: [matriz vigente de la revisión](../../docs/operations/timed-intervals-review-20260913/WORK.md), [FEATURES](../../FEATURES.md), comparación de 40 hashes `phase10-20260913/dependencies.json`. Pruebas nuevas HTTP ejercitan POST real 201, detalle/lista/día, texto legacy, null, normalización trim y rechazo temporal. Las pruebas de App anteriores conservan validez por identidad de fuentes; no se presentan como ejecutadas de nuevo.

## Condición observable para una retirada posterior

### I007-P01: completado de progreso mixto

El cálculo de comandos de progreso conserva cada evidencia según su formato:
una entrada con `training_exercise_id` cuenta solo para esa ocurrencia; una
entrada sin él conserva la evidencia agregada por `exercise_id` del contrato
legacy, aunque existan otras entradas canónicas en el día. No genera asociaciones
ni copia rendimiento a ocurrencias repetidas. La ambigüedad legacy sigue abierta.
El mapa de ocurrencia a ejercicio proviene del contexto de asignación/snapshot
ya cargado. Marcar, completar y desmarcar reutilizan este cálculo, con los mismos
locks, recibos y revisiones. `findDay` conserva su prioridad de confirmación
histórica persistida; no se reasignan evidencias ambiguas sin esa confirmación.

Las 92 asociaciones autorizadas (69 + 23) ya están aplicadas y verificadas.
La auditoría residual del 13 de septiembre conserva 14 entradas sin ocurrencia
(3 con dos candidatos y 11 sin candidato) y 14 grupos duplicados, todos idénticos
a sus correspondientes registros del respaldo de julio. Dos grupos son
idénticos, siete difieren solo en fecha de completado y cinco contienen pesos
o series diferentes. No se borran, fusionan ni suman como sesiones adicionales.
Evidencias, límites, hashes y recuperación:
`../../docs/operations/issue007-p01-apply-20260913/WORK.md` y
`../../docs/operations/issue007-residual-20260913/WORK.md`.

### I007-P02: proteger el residual frente a comandos ordinarios

Marcar un ejercicio o completar un entrenamiento rechaza con HTTP 409 y código
`PROGRESS_HISTORY_AMBIGUOUS` si la ocurrencia objetivo consumiría más de una
entrada histórica, incluso si son iguales. No elige la primera/última, no
combina pesos/series y no guarda recibo de éxito. La comprobación comparte los
locks y la transacción del comando; un retry conserva el rechazo y los datos.
Las otras ocurrencias del día siguen siendo editables. La eliminación explícita
de progreso o de un cliente conserva su contrato previo y no se utiliza como
reparación de los duplicados.

Una entrada sin ocurrencia solo puede reutilizarse al marcar cuando hay una
única ocurrencia posible y una única entrada candidata. Si el ejercicio se
repite, se conserva el registro no atribuido y se crea/edita únicamente la
ocurrencia solicitada, sin copiarle el rendimiento histórico desconocido.

La App reconoce ese conflicto como revisión requerida, conserva la operación,
propietario, revisión y payload y bloquea operaciones posteriores del mismo día.
El overlay, que no tiene contexto autoritativo de asignación, no atribuye una
entrada legacy a una operación canónica ni elige entre duplicados; la respuesta
confirmada del servidor puede resolver una asociación inequívoca. No cambia el
formato persistido. La App anterior conserva los datos y termina en fallo tras
los cinco reintentos acotados de un 409 desconocido; no se exige eliminar colas
ni actualizar todos los dispositivos para proteger la DB con la API corregida.

La política de conservación del residual y mantenimiento del contrato legacy
fue aceptada expresamente por el usuario el 2026-09-13 (ADR-029). ISSUE-007 queda
RESOLVED técnicamente con limitación histórica aceptada, sin declarar recuperada
la información ausente. Véase `../../docs/operations/issue007-accepted-20260913/acceptance.json`.
Implementación local validada; publicación de API/App pendiente.

La compatibilidad legacy se mantiene por decisión aceptada ADR-029. ISSUE-007 está cerrado técnicamente con límite histórico aceptado; la retirada no forma parte de ese cierre y continúa condicionada a las evidencias siguientes. No se afirma ausencia de consumidores/colas instaladas.

Para autorizar otra retirada deben concurrir: inventario actualizado también de scripts/SQL/jobs; auditoría de todos los propietarios con cero filas inequívocas pendientes y cero espejos divergentes; resolución documentada de cada población ambigua sin alterar histórico; sustituto probado de la captura BEFORE; telemetría no personal de formatos/versiones y política de versiones soportadas expresamente aprobada; evidencia de que clientes soportados y colas antiguas ya no dependen del campo; despliegue gradual y rollback de contratos. No hay TTL máximo de desconexión autorizado: esperar N días o migrar tres HEAD no demuestra ausencia de consumidores. Hasta entonces mantener lecturas, escrituras compatibles y campos. ADR-029 satisface la decisión explícita sobre la limitación para el cierre actual. Una fuente verificable nueva, un escritor que aumente la ambigüedad, pérdida de histórico o petición de retirada obliga a reabrir ISSUE-007.
