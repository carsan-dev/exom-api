# Jobs y notificaciones durables

## Contrato y alcance

Uso PostgreSQL como fuente de verdad. `durable_work` conserva la intención, reclamación, intentos y resultado. Los productores confirman negocio y trabajo pendiente juntos; los workers envían después de ese commit. Las transacciones que mantienen una barrera de usuarios durante una llamada externa son barreras de lectura, no la transacción original de negocio.

`DONE` en un productor/reconciliador significa que terminó sus cálculos y confirmó todas sus intenciones hijas. Para comprobar la entrega, consulto cada trabajo FCM/EMAIL; un productor DONE no implica que sus destinatarios hayan recibido mensajes. Los jobs de retención procesan el lote existente; los journals de uploads/eliminación siguen identificando operaciones incompletas.

| Productor | Escritura atómica e identidad |
| --- | --- |
| Scheduler | `schedule:<template>:<fecha local>:<hora local>`, con instante original en payload. Dos instancias comparten la clave. La hora repetida por DST se deduplica. |
| Retención/racha diaria | Clave por fecha o intervalo de 30 minutos. La ocurrencia persistida sobrevive al reinicio. |
| Progreso, métricas, rachas y asignación/completado de retos | Trigger `RECONCILE`, propietario + `txid_current()`. Varias escrituras de la misma transacción se agrupan; transacciones distintas conservan trabajo independiente. |
| Hito de racha | Propietario + inicio de seguimiento + última actividad + hito (7/30/100/365). Recompletar el mismo hito no duplica el evento. Los datos legacy sin fecha conservan una identidad `unknown`. |
| Logros y retos | Usuario + logro/reto + tipo de evento. Revocar/reconceder no vuelve a notificar el mismo desbloqueo. El catálogo automático también deja reconciliación durable; pasar a CUSTOM elimina solo concesiones AUTOMATIC dentro de la transacción. |
| Planificación, feedback, asignaciones de cliente | `queueTemplate(tx, ...)` crea notificaciones PENDING en la transacción del negocio. |
| Invitación de alta | Intención EMAIL en la transacción de creación del usuario, clave estable por usuario. Reset/reenvío explícito crea una nueva intención. |
| Aprobaciones | Solicitud + pendiente/resolución. APPROVED no prueba ejecución: se exige `execution_completed_at`. Un resultado incierto no se reejecuta automáticamente. |
| FCM | ID de Notification, un trabajo por destinatario. Los hijos de un evento usan un ID determinista derivado del evento/destinatario/tipo/contexto. |

Los reconciliadores leen el estado actual bajo los locks de progreso. Una operación vieja retrasada no vuelve a aplicar un estado pasado. Los grants, transiciones y nuevas intenciones se confirman juntos. Mantengo las respuestas síncronas existentes; su fallo post-commit ya no exige que el cliente vuelva a intentar para recuperar el cálculo.

Recupero las ocurrencias que ya estaban persistidas. No genero recordatorios para los minutos en los que todas las instancias estuvieron apagadas. La migración crea reconciliaciones iniciales de clientes, sin inventar envíos históricos.

## Reclamación, concurrencia y fallos

Cada tick (5 segundos) intenta cuatro advisory locks transaccionales globales, namespace 61006. Cada slot procesa como máximo un trabajo y toma además un advisory lock por clave. La reclamación se confirma en una escritura CAS independiente: estado RUNNING, token nuevo, intento incrementado y lease de cinco minutos. Fechas de elegibilidad y lease usan reloj PostgreSQL convertido explícitamente a UTC.

El guard usa una conexión del pool existente y una transacción PostgreSQL propia, sin el deadline de callbacks Prisma. SET LOCAL desactiva idle_in_transaction_session_timeout solo en esa transacción de locks. Un worker vivo mantiene su lock aunque el lease se haya vencido. Un handler bloqueado conserva su slot: el estado RUNNING/lease vencido permite diagnosticarlo y reiniciar el proceso; no se libera el lock por un timeout mientras su código sigue ejecutándose. Tras perder la conexión/terminar el proceso, PostgreSQL libera el lock y otro worker recupera la fila al vencer el lease. Las actualizaciones finales comprueban el token. Los payloads y recibos de email también comprueban reclamación y estado: un worker antiguo no puede sobrescribir una aceptación posterior.

He fijado un límite de ocho intentos con presupuesto de ejecución. `attempts` cuenta reclamaciones: recuperar una octava reclamación abandonada puede registrar una novena, que solo verifica el recibo o declara presupuesto agotado, sin otro envío. Backoff exponencial desde 5 segundos (`min(1 hora, 5s * 2^(intento-1))`); sin intento automático después de FAILED. Un crash que consumió el último intento se recupera conservadoramente: no se vuelve a enviar sin presupuesto; un recibo ya persistido permite completar el journal sin repetir el envío. Los errores persistidos son códigos propios, sin respuestas privadas del proveedor.

Hay como máximo cuatro trabajos activos mientras sus conexiones de guard permanecen vivas. Cada proceso evita acumular otra ejecución de un slot local ocupado. Ante un fallo de fan-out, se espera a todas las tareas iniciadas antes de cerrar el intento y se detiene la reclamación de nuevos destinatarios. Cada trabajo FCM/EMAIL tiene un destinatario; el fan-out de notificaciones usa cuatro tareas y la audiencia completa se confirma antes del primer envío manual. El materializador de planes conserva su límite de ocho tareas de DB. En los cron de identidad/eliminación mantengo los journals, locks/CAS y límites de la fase 5, incluidos sus recuperadores y las decisiones ADR-016/017.

Las inserciones de trabajo y de hijos deterministas usan ON CONFLICT DO NOTHING; no dependen de un upsert Prisma con actualización vacía. Antes de enviar, vuelvo a comprobar la asignación del destinatario de avisos internos sobre clientes y el rol del reviewer de aprobación pendiente. Una revocación posterior no puede retirar una petición ya admitida.

Una conexión perdida no cancela una petición que el proveedor ya recibió. Los locks y el fencing protegen el estado local; no crean una transacción distribuida ni eliminan esa ventana externa.

## Qué significa envío aceptado

| Canal | Evidencia y deduplicación |
| --- | --- |
| FCM | Notification.SENT exige respuesta con message ID; se guardan `provider_message_id` y `sent_at`. PENDING nunca se trata como aceptación. `notification_id` estable permite correlación, pero FCM no ofrece una clave de idempotencia de envío para este flujo y la App actual no garantiza deduplicar la visualización. |
| Email Firebase | EMAIL/DONE con `payload.accepted=true`, canal y fecha; se exige respuesta satisfactoria con el email esperado. La dirección queda fijada al primer intento; un cambio de dirección impide redirigir el retry. No hay deduplicación del proveedor en este flujo. |
| Email Resend | Respuesta satisfactoria con ID, guardada antes de DONE. Se persisten primero el cuerpo exacto, dirección, canal y fecha; todos los retries usan el mismo cuerpo y `Idempotency-Key`. Cambio de dirección o configuración incompatible falla de forma visible. Se deja de enviar a las 23 horas desde preparación, dentro de la ventana de 24 horas del proveedor. |

Aceptación significa que el proveedor aceptó la solicitud, **no lectura, entrega al dispositivo ni entrega al buzón**. `read_at` sigue siendo una señal independiente de la bandeja de EXOM. Conservo las notificaciones SENT anteriores a la migración con sus recibos nulos; no añado evidencia de aceptación que no se guardó en su momento.

Si se pierde la respuesta, o el proceso cae tras la aceptación y antes del recibo local, el trabajo queda ambiguo y reintenta hasta su límite. FCM y Firebase email pueden duplicar mensajes. Resend deduplica dentro de su ventana con clave/cuerpo idénticos; fuera de ella el worker falla y requiere revisión. Tras guardar el recibo, un reinicio completa el journal sin reenviar. La garantía es intención durable y procesamiento recuperable con intentos acotados, no entrega garantizada ni exactamente una vez.

Referencias que uso para estos contratos: [FCM Admin send](https://firebase.google.com/docs/cloud-messaging/send/admin-sdk), [métricas de aceptación y entrega FCM](https://firebase.google.com/docs/cloud-messaging/understand-delivery), [idempotencia Resend](https://resend.com/docs/dashboard/emails/idempotency-keys). Las pruebas automatizadas usan proveedores simulados; no acreditan recepción real.

## Operación y recuperación

`GET /notifications/delivery-work`, protegido para SUPER_ADMIN, devuelve contadores por tipo/estado y hasta 100 trabajos, priorizando FAILED. Solo expone identificadores, fechas, intentos y código de error; nunca el payload. La tabla tiene RLS sin políticas de clientes, siguiendo el acceso exclusivo de la API. Para un diagnóstico completo, consulto con el rol de servicio:

```sql
SELECT key, kind, status, attempts, next_attempt_at, lease_until, last_error
FROM durable_work
WHERE status IN ('FAILED', 'RUNNING', 'PENDING')
ORDER BY status, next_attempt_at, key;
```

No borro filas RUNNING ni reinicio todos los FAILED. Antes de recuperar un trabajo, identifico su propietario, la causa del fallo y si el proveedor acredita la aceptación. Si el resultado es ambiguo, no lo marco como éxito. Si una aprobación no tiene recibo, reviso la acción de negocio antes de guardar evidencia; no la ejecuto otra vez por suposición. Guardar posteriormente el recibo de ejecución reactiva cualquier aviso sin terminar, incluyendo RUNNING. El token anterior se retira; su finish ya no puede sobrescribir la reactivación. El advisory lock conserva exclusión hasta que ese consumidor termine. La migración de wakeup recupera además confirmaciones atascadas anteriores.

Cuando recupero un fallo ya corregido y con autorización, conservo la misma clave. Bloqueo la fila, compruebo que está en FAILED y que no hay un worker vivo, la paso a PENDING y reinicio el presupuesto acordado. Mantengo el cuerpo, el canal y la identidad de la operación. FCM debe volver a PENDING en la misma transacción, conservando cualquier SENT ya acreditado. Un email Resend fuera de ventana requiere resolución del resultado anterior; reiniciar sus intentos no evita el rechazo del worker. No he añadido un `--apply` automático.

Conservo las claves DONE y FAILED para deduplicación y diagnóstico, sin purga automática. El payload privado de Resend contiene temporalmente el enlace de acción: se retira al guardar aceptación; un FAILED lo conserva para revisión controlada. No exporto ese payload a logs ni a la interfaz. Al eliminar definitivamente al propietario, las FK y los triggers de eliminación de notificaciones retiran su trabajo propio; no dejan replays contra otra cuenta.

El historial por defecto mantiene SENT/FAILED para los clientes Admin existentes; PENDING puede consultarse explícitamente. Si un envío manual sigue pendiente, la API devuelve 503 con esa explicación para evitar el toast antiguo de éxito. No hay idempotencia entre dos nuevas peticiones manuales: repetir la solicitud crea una nueva intención. La bandeja puede mostrar contenido ya confirmado en DB antes de aceptar el push, y limpiar mensajes leídos conserva los PENDING.

## Activación y comprobación

Las cinco migraciones `20260911100000` a `20260911100300` y `20260912010000_approval_work_wakeup` son aditivas. La última sustituye el trigger de rearme y recupera trabajo confirmado sin terminar; conserva identidades, recibos y DONE. El enum PENDING debe confirmar antes de usarse, por eso se separa su migración. Antes de arrancar esta versión, aplico esas migraciones y regenero Prisma. La garantía horizontal requiere retirar todos los schedulers de la versión antigua: sus locks en memoria no cooperan con PostgreSQL. No mantengo indefinidamente workers antiguos y nuevos a la vez. Si tengo que revertir la versión, conservo la outbox y sus recibos; no elimino la tabla para volver atrás.

La conexión Prisma debe soportar transacciones PostgreSQL y advisory locks mantenidos durante el trabajo; un pooler de statements no sirve. Reutilizo el pool existente, sin añadir un broker. Para comprobar la concurrencia, uso dos pools contra PostgreSQL real con interleavings controlados y reinicios simulados.

Para validar los cambios, ejecuto: `npm run prisma:generate`, `npm exec -- prisma validate`, `npm run build`, `npm test -- --runInBand`, `npm run test:concurrency` y lint sin auto-fix. `TEST_DATABASE_URL` debe identificar una DB desechable; no doy por pasadas las suites PostgreSQL si se omiten por falta de URL.
