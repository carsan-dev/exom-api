# Servicio base: entregas mensuales de PDF por email

Suscripción mensual separada del coaching de la App. Cada mes pagado, un admin pulsa «enviar mes N» (tras confirmar el pago fuera de la plataforma) y el suscriptor recibe un email con los PDF de ese mes adjuntos. Los suscriptores no son usuarios de la App: no tienen Firebase, invitación ni recordatorios.

## Modelo de datos (migración `20261114120000_base_service`)

| Tabla | Contenido y reglas |
| --- | --- |
| `base_subscribers` | `order_code` (`EXB-000123`, secuencia `base_subscriber_order_seq` vía `exom_next_base_order_code()`, único, inmutable por trigger; un insert rechazado deja hueco), `name` (normalizado con `normalizeClientName`), `email` (minúsculas, único entre no archivados por índice parcial `lower(email)`), `goal`, `days_per_week` (1-7), `notes`, `is_archived` + `archived_at`, `created_by_id`. |
| `base_deliveries` | Una fila por (suscriptor, mes) (índice único). Inmutables (trigger): suscriptor, mes, objetivo, días, pedido, `files` y `requested_at`. `snapshot_name`/`snapshot_email` son el destinatario del ÚLTIMO envío: el trigger solo deja cambiarlos en la misma actualización que abre el envío siguiente (`send_seq + 1` y vuelta a `PENDING`), es decir, un reenvío. `files`: `filename`, `source_key`, `source_sha256` (vinculantes para toda la entrega) y `sha256`/`size` del PDF sellado del envío ORIGINAL. `status` (`PENDING`/`SENT`/`FAILED`) y `last_error` describen el último envío (`send_seq`); `sent_at`/`provider_message_id`, el último aceptado. FK a suscriptor `RESTRICT`. |
| `durable_work` (existente) | Un trabajo `BASE_DELIVERY_EMAIL` por envío, clave `base-delivery:<delivery>:<send_seq>`, sin `owner_id` (no es un `User`). Su payload es el registro de ESE envío (`sends` en la API): quién y cuándo lo pidió, su destinatario (`name`, `email`), sus archivos (`files`, con los hashes sellados de ese envío), las llamadas al proveedor iniciadas (`handoffs`, `lastHandoffAttempt`), el recibo y, si falló, `possiblyDelivered`. |

Ambas tablas tienen RLS activado sin políticas de cliente y sin permisos para `anon`/`authenticated`, como el resto de tablas de la API.

## Flujo

1. Alta/edición: nombre y email se normalizan y se validan contra la tipografía del sello; después, juntos, deben caber en la línea de licencia (regla de longitud del sello, abajo; 400 `STAMP_TOO_LONG`). Una edición de solo uno de los dos se comprueba con el otro tal como está guardado, bajo el bloqueo de la fila. Objetivo y días deben existir en el catálogo. Los cambios solo afectan a entregas futuras.
2. «Enviar mes N»: N debe ser el mes máximo existente + 1 (o 1) y, si N > 1, la entrega del mes N−1 debe estar `SENT` (estado efectivo, ver «Estado efectivo»); si está `PENDING` o `FAILED`, 409 `PREVIOUS_MONTH_NOT_SENT` (hay que esperar a que termine o reenviarla). La API construye y sella el paquete antes de bloquear (comprueba que el contenido existe, que el sello cabe y registra hashes), y después, en una transacción con la fila del suscriptor bloqueada (`FOR UPDATE`), repite las reglas en una sola consulta, inserta la entrega e inserta el trabajo durable (outbox). Dos peticiones simultáneas del mismo mes producen una entrega y un email; la otra recibe 409 `DELIVERY_EXISTS`. El índice único es la última barrera. La vuelta de N−1 a `PENDING` (reenvío, con `FOR UPDATE`) se serializa con ese bloqueo; los pasos a `SENT` y `FAILED` (worker) no lo toman: la regla lee el estado confirmado y, si el `SENT` llega justo después, la respuesta es un rechazo que basta con repetir.
3. Worker (`BaseDeliveryWorker`, mecanismo `durable_work` existente): recarga la entrega, reconstruye los PDF sellados con el destinatario de ESE envío y la ruta de la entrega, comprueba que coinciden byte a byte con los hashes que registró ese envío, toma la barrera de archivo compartida (abajo), comprueba que el suscriptor no está archivado, cuenta la llamada en el payload y manda un único email Resend con los adjuntos en Base64 e `Idempotency-Key` = clave del trabajo. Guarda el recibo y marca `SENT` en la misma transacción.
4. Reenvío explícito de una entrega `SENT` o `FAILED` (estado efectivo; ver «Reenvío»): `send_seq + 1`, nueva clave, nombre y email ACTUALES del suscriptor, misma ruta y mismos PDF de origen. No se permite mientras esté `PENDING`.

## Instantánea por envío

Cada envío (`send_seq`) tiene su propio destinatario (nombre y email) y sus propios hashes sellados, guardados en el payload de su trabajo al crearlo. El envío 1 toma los datos del suscriptor al pedir el mes; un reenvío toma los datos ACTUALES del suscriptor en el momento del reenvío. Los reintentos de un mismo envío usan siempre su instantánea: nunca cambian de dirección a mitad de un envío. `snapshot_name`/`snapshot_email` de la entrega son los del último envío (se actualizan en la misma transacción que crea el envío). Objetivo, días, mes, pedido y PDF de origen son de la entrega y no cambian nunca.

## Reenvío

1. Comprobaciones sin bloqueo: Resend y origen configurados (503), suscriptor y entrega existen (404), suscriptor no archivado (409 `SUBSCRIBER_ARCHIVED`), entrega no `PENDING` en estado efectivo (409 `DELIVERY_PENDING`; una entrega `PENDING` cuyo envío actual ya terminó `FAILED` sin registrarlo se acepta como fallida).
2. Fuera de cualquier bloqueo, construye y sella el paquete con el nombre y email ACTUALES del suscriptor y la ruta de la entrega, con las mismas validaciones que al pedir un mes (400 `INVALID_NAME`/`INVALID_EMAIL` si una fila antigua no las cumple; 400 `INVALID_ORDER_CODE` si el código de pedido guardado no es válido, que no se puede editar: problema interno de datos, el mensaje pide avisar al equipo técnico; 409 `STAMP_TOO_LONG`; contenido 409/503; 409 `ATTACHMENTS_TOO_LARGE`).
3. Los PDF de origen deben ser los mismos de la entrega (mismos archivos, mismo orden y mismo `source_sha256`); si no, 409 `SOURCE_CHANGED_SINCE_DELIVERY`. Decisión: se rechaza (opción a) en vez de registrar el nuevo hash, porque un reenvío promete «el material de ese mes» y el admin no puede distinguir un PDF corregido de uno equivocado; el arreglo es operativo (restaurar el archivo).
4. Transacción con la fila del suscriptor `FOR UPDATE` (el mismo bloqueo que toman las ediciones): si nombre o email difieren de los usados para sellar, 409 `SUBSCRIBER_CHANGED` (reintentar); después la entrega `FOR UPDATE`: si su `send_seq` o su `status` ya no son los leídos antes del bloqueo (otro reenvío se confirmó mientras tanto, aunque ya se haya enviado), 409 `DELIVERY_CHANGED` y no se escribe nada (evita un email de más cuando dos admins reenvían a la vez); si sigue `PENDING` y su envío no ha terminado, 409 `DELIVERY_PENDING`; si su envío terminó `FAILED` sin registrarlo, primero se guarda ese envío como `FAILED` `SEND_STATE_UNRECORDED` y en la misma transacción `send_seq + 1`, `PENDING`, nuevo destinatario, y el trabajo durable. Cualquier rechazo no cambia nada.

Sin ediciones, el reenvío produce los mismos bytes (sellado determinista) y va a la misma dirección.

## Reglas de hash

- `source_sha256`: de la ENTREGA. Se registra al pedir el mes. Cada envío lleva las mismas fuentes que la entrega (el worker lo comprueba) y los bytes leídos deben coincidir; un reenvío con una fuente cambiada se rechaza (409, arriba).
- `sha256`/`size` sellados: de cada ENVÍO. Se registran al crear el envío y solo se exigen entre reintentos de ese mismo envío (protegen el cuerpo que Resend asocia a la `Idempotency-Key`). Un cambio de `@cantoo/pdf-lib`, `@cantoo/fontkit`, la fuente o el destinatario solo afecta a los envíos ya creados que aún no han salido (`FAILED` `BASE_SOURCE_CHANGED`, no ambiguo si nunca se llamó al proveedor); un reenvío registra los hashes nuevos y funciona.

Los PDF sellados no se guardan en ningún sitio: se regeneran en cada intento. El sellado es determinista (`@cantoo/pdf-lib` usa un RNG con semilla fija para nombres de fuente/recursos), lo que permite reintentar con el mismo cuerpo y la misma clave.

## Garantías y límites

- Intención durable y procesamiento recuperable, no entrega exactamente una vez. Aceptación = Resend devolvió un id; no prueba entrega en buzón ni lectura. No hay webhooks: un rebote posterior no se ve en EXOM.
- Reintentos: 8 intentos como máximo (`WORK_MAX_ATTEMPTS`), backoff `5 s × 2^(n-1)` (5, 10, 20, 40, 80, 160, 320 s): todos dentro de ~11 minutos si el proceso está vivo; un crash añade la espera del lease (5 min). Cada reintento reutiliza el cuerpo guardado (sin adjuntos) y adjuntos idénticos, así que Resend deduplica dentro de su ventana de 24 h.
- Crash tras la aceptación del proveedor y antes de guardar `SENT`: el reintento usa la misma clave y el mismo cuerpo y recibe el mismo id (sin duplicado). Si han pasado 23 h desde el primer intento (API caída más de un día), el worker no reenvía: `FAILED` `EMAIL_DEDUP_WINDOW_EXPIRED`; un reenvío manual podría duplicar el email.
- Errores transitorios (red, timeout, 5xx, 429, 409 de petición idempotente en curso): reintento. Permanentes (400/422 dirección o adjunto inválidos, 401/403 clave o dominio, 409 misma clave con otro cuerpo): `FAILED` sin reintento. Un `FAILED` con código transitorio tras agotar intentos es ambiguo: el email pudo llegar; compruébalo antes de reenviar.
- Archivar espera a un envío en curso (como máximo el timeout de 60 s del proveedor) y bloquea los siguientes: el trabajo pendiente termina `FAILED` `SUBSCRIBER_ARCHIVED` (ambiguo si un intento anterior ya llamó al proveedor, ver tabla).
- Un PDF retirado del catálogo deja el envío en `FAILED` `BASE_CONTENT_UNAVAILABLE` (o `BASE_SOURCE_NOT_FOUND` si desaparece entre listar y leer); uno modificado, en `BASE_SOURCE_CHANGED`. El reenvío exige los mismos bytes de origen.
- Regla de longitud del sello: la línea `Licencia personal · <nombre> · <email> · Pedido <código>` baja de 6,5 pt hasta un mínimo de 4 pt para no superar el 70 % de la altura visible de la página; nunca se dibuja más pequeña ni recortada. Todos los PDF entregados son A4 vertical (comprobado en los 91 PDF / 1296 páginas de `entrega-cliente-final`), así que el límite es 589,323 pt a 4 pt (`STAMP_PRODUCT_PAGE_HEIGHT`). `measureSubscriberStamp` (en `base-delivery-input.ts`) mide nombre + email con la tipografía del sello y el código más ancho posible, `EXB-000000` (las cifras son proporcionales; el 0 es la más ancha). Se aplica en alta/edición (400), al crear una entrega o un reenvío con los datos actuales del suscriptor (409, para filas antiguas o escritas fuera de la API) y en el worker (`FAILED` `BASE_STAMP_TOO_LONG`, permanente, sin enviar). `stampPdf` además rechaza con `STAMP_TOO_LONG` cualquier página en la que la línea real no quepa. Referencias: un nombre de 80 «A» admite emails de hasta 126 caracteres; «Ana», hasta 209. Los códigos a partir de `EXB-1000000` tienen 7 cifras: ahí solo protege la comprobación de `stampPdf`.
- Los errores guardados son códigos propios; nunca texto del proveedor, contenido de adjuntos ni la API key. El payload del trabajo conserva el cuerpo (con nombre y email) hasta la aceptación, como el EMAIL existente, y el destinatario de cada envío (`name`, `email`) de forma permanente como historial.

## Barrera archivo/envío y conexiones

El worker no mantiene ninguna transacción Prisma ni bloqueo de fila mientras sella ni mientras espera al proveedor. La garantía «un archivo o se confirma antes de que el envío compruebe el suscriptor (y no se envía) o espera a que el proveedor responda» se mantiene con un advisory lock por suscriptor (`exom:base-subscriber-send:<id>`): el worker lo toma COMPARTIDO en la conexión guardia del trabajo (la que `JobsService` ya fija durante todo el elemento para sus advisory locks; se libera al terminar el elemento) antes de leer `is_archived`; archivar lo toma EXCLUSIVO en su transacción, después del `FOR UPDATE` del suscriptor. Varios envíos del mismo suscriptor no se bloquean entre sí. Orden: `users` → `base_subscribers` → barrera → `base_deliveries` → `durable_work`; el worker solo toma la barrera y después hace lecturas y escrituras cortas sin bloqueos de fila, así que no hay ciclo. Por envío en curso queda fijada una conexión (la guardia), no dos: con 4 ranuras, 4 conexiones del pool (`DATABASE_POOL_MAX` 10 por defecto) más escrituras cortas. Toda escritura que ponga `is_archived = true` debe tomar la barrera (`lockSubscriberSendBarrier`).

El paso de N−1 a `SENT` ya no toma `FOR SHARE` sobre el suscriptor: «enviar mes N» lee el estado confirmado bajo su `FOR UPDATE`; si el `SENT` llega justo después, la petición recibe `PREVIOUS_MONTH_NOT_SENT` y basta con repetirla. La vuelta a `PENDING` (reenvío) sí toma `FOR UPDATE`, así que nunca se crea N sobre un N−1 que se está reenviando.

## Clasificación de fallos terminales

Un envío `FAILED` es AMBIGUO (`possibly_delivered = true` en la API: «puede que el email sí haya llegado») salvo que se pueda probar que no salió nada. Antes de cada llamada al proveedor el worker guarda en el payload `handoffs + 1` y `lastHandoffAttempt` (número de intento). Al marcar `FAILED` (hook en la misma transacción, `sendPossiblyDelivered`):

- `handoffs = 0`: nunca se entregó nada al proveedor → no ambiguo («no se envió»).
- `handoffs = 1`, hecha por el intento que falla y respondida con un rechazo definitivo (`EMAIL_REQUEST_REJECTED`, `EMAIL_PROVIDER_AUTH_REJECTED`, `EMAIL_PROVIDER_REJECTED`, `EMAIL_PROVIDER_NOT_CONFIGURED`) → no ambiguo.
- Cualquier otro caso (`handoffs ≥ 2`, o una llamada anterior sin respuesta definitiva) → ambiguo.

| Punto del handler | Código | Sin llamada previa | Con llamada previa |
| --- | --- | --- | --- |
| Payload ilegible o clave distinta | `INVALID_BASE_DELIVERY_INTENT` | la fila de la entrega no se toca (inalcanzable por la API); se lee `FAILED` `SEND_STATE_UNRECORDED` (estado efectivo), `possibly_delivered = true` (no determinable) | igual |
| Sin claim (no ocurre desde `JobsService`) | `CLAIM_REQUIRED` | no enviado | ambiguo |
| Entrega borrada / otro `send_seq` o ya no `PENDING` | `BASE_DELIVERY_NOT_FOUND`, `BASE_DELIVERY_SUPERSEDED` | no enviado | ambiguo |
| Destinatario del payload distinto de la fila o del cuerpo guardado | `EMAIL_RECIPIENT_CHANGED` | no enviado | ambiguo |
| Resend sin configurar (comprobado antes de llamar) | `EMAIL_PROVIDER_NOT_CONFIGURED` | no enviado | ambiguo |
| Ventana de 23 h superada (solo existe con llamada previa) | `EMAIL_DEDUP_WINDOW_EXPIRED` | — | ambiguo |
| `files` de la entrega ilegibles o fuentes del envío distintas | `BASE_DELIVERY_FILES_INVALID` | no enviado | ambiguo |
| Catálogo: origen sin configurar, PDF ausente, ruta sin contenido, PDF o sellado distinto del registrado, sello que no cabe, instantánea inválida | `BASE_SOURCE_NOT_CONFIGURED`, `BASE_SOURCE_NOT_FOUND`, `BASE_CONTENT_UNAVAILABLE`, `BASE_SOURCE_CHANGED`, `BASE_STAMP_TOO_LONG`, `BASE_SNAPSHOT_INVALID` | no enviado | ambiguo |
| Almacenamiento caído hasta agotar intentos | `BASE_SOURCE_UNAVAILABLE` | no enviado | ambiguo |
| Suscriptor borrado / archivado (leído tras la barrera) | `BASE_SUBSCRIBER_NOT_FOUND`, `SUBSCRIBER_ARCHIVED` | no enviado | ambiguo |
| Claim perdido al contar la llamada | `CLAIM_LOST` | el trabajo no cambia (lo tiene otro worker) | igual |
| Respuesta del proveedor: rechazo definitivo | `EMAIL_REQUEST_REJECTED`, `EMAIL_PROVIDER_AUTH_REJECTED`, `EMAIL_PROVIDER_REJECTED`, `EMAIL_PROVIDER_NOT_CONFIGURED` | no enviado (única llamada, rechazada) | ambiguo |
| Respuesta del proveedor: misma clave con otro cuerpo | `EMAIL_IDEMPOTENCY_CONFLICT` | ambiguo | ambiguo |
| Respuesta transitoria hasta agotar intentos | `EMAIL_PROVIDER_UNAVAILABLE`, `EMAIL_PROVIDER_RATE_LIMITED`, `EMAIL_PROVIDER_UNREACHABLE`, `EMAIL_ACCEPTANCE_MISSING`, `EMAIL_IDEMPOTENCY_IN_PROGRESS` | ambiguo (el propio intento llamó) | ambiguo |
| Error inesperado (p. ej. al guardar la aceptación) hasta agotar intentos | `ATTEMPT_FAILED_OR_AMBIGUOUS` | no enviado si fue antes de llamar; si no, ambiguo | ambiguo |
| Claim tras agotar intentos sin aceptación | `ATTEMPTS_EXHAUSTED` | no enviado | ambiguo |
| Cualquiera de los anteriores con el hook fallando 3 veces | el código del trabajo (`sends[].error`); la entrega se lee `FAILED` `SEND_STATE_UNRECORDED` | no enviado (recalculado al leer) | ambiguo (recalculado al leer) |

Los reintentos tras una llamada reutilizan clave y cuerpo, así que un reintento aceptado nunca duplica. Una llamada contada que no llegó a salir (caída justo después de guardarla) se trata como ambigua: error del lado prudente.

`possibly_delivered` en la API: si el payload de un envío `FAILED` tiene la marca guardada por el hook, se respeta; si no la tiene (el hook no llegó a correr), se calcula al leer con la misma regla (`sendPossiblyDelivered(payload, attempts, last_error)` del trabajo); si el payload es ilegible, `true`.

## Hook de fallo terminal (`JobsService`)

`onTerminalFailure` corre en la transacción que marca el trabajo `FAILED`. Si lanza, esa transacción se reintenta hasta `TERMINAL_HOOK_TRIES` (3) veces; después el trabajo se marca `FAILED` sin el hook y se registra un error con la clase del error (nunca su mensaje). No hay bucle: el elemento queda terminal. Si el hook falla 3 veces seguidas (o el payload es ilegible y el hook no puede actuar), la fila de la entrega queda `PENDING` con su trabajo `FAILED`; se resuelve sola con el estado efectivo (abajo), sin tarea de reparación ni SQL manual. EMAIL y FCM no usan hook y no cambian.

## Estado efectivo de una entrega

Una entrega cuya fila está `PENDING` y cuyo envío ACTUAL (clave `base-delivery:<entrega>:<send_seq>`) tiene el trabajo `BASE_DELIVERY_EMAIL` en `FAILED` sin aceptación es, a todos los efectos, `FAILED`. Un trabajo `FAILED` no se vuelve a reclamar nunca, así que el estado no puede volver atrás.

- Lectura (listado y detalle de entregas, `latest_delivery` del suscriptor): `status = FAILED`, `last_error = SEND_STATE_UNRECORDED`, `possibly_delivered` del último envío (calculado como arriba); `sends[last].error` conserva el código real del trabajo.
- Regla del mes siguiente: cuenta como `FAILED` (bloquea N+1 con el mensaje de fallo hasta reenviar), nunca como `SENT`.
- Reenvío: se acepta como envío fallido. Bajo el bloqueo de la entrega se guarda ese envío como `FAILED` `SEND_STATE_UNRECORDED` y, en la misma transacción, se abre el siguiente (`send_seq + 1`). El trigger de inmutabilidad ya permite ambas actualizaciones (no cambia la migración).
- Implementación: `sendFailureUnrecorded` y su forma SQL `effectiveDeliveryStatusSql` (`base-delivery-state.ts`) deben coincidir.

## Variables de entorno

| Variable | Uso |
| --- | --- |
| `R2_BASE_PDF_BUCKET` | Bucket privado con los PDF de origen. Reutiliza `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`. Si coincide con `R2_BUCKET_NAME` (o `exom-media`) o faltan credenciales, la función queda sin configurar; nunca cae a otro bucket. |
| `BASE_PDF_LOCAL_DIR` | Solo desarrollo/tests (ignorada con `NODE_ENV=production`) y solo si no hay bucket. |
| `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `EMAIL_LOGO_URL`, `SUPPORT_URL` | Existentes. Sin Resend las peticiones de envío responden 503 `EMAIL_NOT_CONFIGURED`; no hay alternativa Firebase. |

## Despliegue (lo autoriza y ejecuta el propietario; nada de esto se ha hecho)

1. Crear en la cuenta R2 existente un bucket privado nuevo (sin dominio público ni acceso `r2.dev`) y confirmar que las credenciales de la API pueden leerlo (listar y leer objetos).
2. Subir los 91 PDF de `exom-site/exom-base-pdfs` respetando las carpetas (`entrenamiento/<objetivo>/...`, `nutricion/<objetivo>/...`, `nutricion/EXOM_Nutricion_Guia-de-inicio.pdf`) en la raíz del bucket, y verificar los SHA-256 contra el manifiesto de entrega.
3. Configurar `R2_BASE_PDF_BUCKET` (y comprobar `RESEND_*`, `SUPPORT_URL`) en el entorno de la API.
4. Aplicar la migración `20261114120000_base_service` con `prisma migrate deploy` en el entorno autorizado, después de validarla (`node scripts/validate-base-service-migration.cjs` contra la base desechable).
5. Desplegar la API y comprobar `GET /api/v1/admin/base-service/routes` antes del primer envío real.

## Deuda abierta

- Borrado definitivo y retención de datos personales de suscriptores (nombre, email en filas, instantáneas y payloads de `durable_work`, incluidas direcciones antiguas corregidas con un reenvío): no implementado; la FK `RESTRICT` impide borrar un suscriptor con entregas.
- Sin integración de pagos: el admin confirma el pago fuera de la plataforma.
- Roles: ADMIN y SUPER_ADMIN (`BASE_SERVICE_ROLES`); endurecer a SUPER_ADMIN es un cambio de una línea.
