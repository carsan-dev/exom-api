# Activar y operar la congelación diaria de adherencia

**Esta guía prepara la operación; NO autoriza ejecutarla.** Cada conexión requiere autorización para el destino, la acción y la sesión que se utilizará. Cada paso que cambie producción requiere autorización expresa del propietario para la acción, el entorno y la población. No reutilizar credenciales o sesiones por su mera disponibilidad. No registrar secretos, cadenas de conexión ni identificadores de clientes.

Alcance: U3 / PR-3 de ADH-FREEZE-01, §§9–10, con las decisiones P1–P6 de §12 bis. La instalación del esquema (PR-1), el despliegue del lector (PR-2) y la activación operativa (U6) son acciones distintas. La medición y posterior desactivación de los 16 triggers de journals pertenecen a U0/U5 / PR-4: **fuera de este alcance**. No se eliminan journals, épocas, snapshots ni código heredado.

## Puertas previas obligatorias

1. Registrar el destino y la autorización, los artefactos revisados y el procedimiento de recuperación. Confirmar por separado el rol efectivo de la conexión de la API y el del operador; el nombre de una configuración no prueba la identidad.
2. **Aplicar la migración PR-1 `20261117120000_adherence_day_bases` ANTES de desplegar la API que lee la tabla.** Requiere autorización expresa del propietario. Si falta la tabla, el GET falla con `42P01` y devuelve 500; no hay respaldo automático para una tabla ausente.
3. Verificar tabla, funciones, propietarios, privilegios y RLS con el bloque 1 de `scripts/sql/adherence-day-freeze/diagnose.sql`. Ese bloque no necesita ni PR-1 ni pg_cron; los demás se ejecutan solo cuando existen sus dependencias. Una tabla recién creada debe tener cero filas; si ya hay filas, registrar su cobertura, no vaciarla.
4. Confirmar que el operador, el propietario de las tablas y funciones y el usuario de los jobs son `postgres`. Según §12 bis U0, la API de producción conecta como el propietario `postgres` por Supavisor, con `rolbypassrls=true` y sin ser superusuario. Es evidencia histórica: comprobar que sigue siendo así antes de activar. No conceder BYPASSRLS, cambiar políticas ni desactivar RLS para superar las guardas.
5. Verificar que `row_security_active` es falso en las seis tablas de la guarda: `users`, `plan_assignments`, `plan_assignment_trainings`, `training_exercises`, `training_day_snapshots` y `adherence_day_bases`. Revisar también `diet_day_snapshots`, los ACL y las políticas de la tabla nueva. Las funciones constructoras deben ser `STABLE` e invocadoras y las de congelación `VOLATILE` e invocadoras. Los roles existentes `anon`, `authenticated` y `service_role` no deben poder ejecutar la congelación ni leer la tabla.

### Permisos del lector: dos fallos distintos (§11.7)

| Rol efectivo de la API | Resultado |
| --- | --- |
| Sin `SELECT` sobre `adherence_day_bases` | PostgreSQL devuelve `42501`; el GET falla. No es un respaldo silencioso. |
| Con `SELECT`, pero sujeto a RLS, sin BYPASSRLS ni política que permita leer | Ve cero filas y vuelve silenciosamente al plan actual (`current_fallback`). Tener `SELECT` no acredita cobertura. |
| Propietario `postgres` con BYPASSRLS, como en §12 bis | Lee las filas, incluso con FORCE RLS. Verificar identidad, propiedad y privilegios reales. |

El propietario de una tabla sin FORCE RLS normalmente evita RLS por propiedad; para un rol distinto, no basta con `SELECT`. Si cambia el rol productivo, detener la activación y preparar por separado los permisos/políticas mínimos con autorización expresa. `row_security=off` no concede bypass. La guarda del trabajo rechaza RLS activa con `42501` antes de congelar.

## Paso previo de solo lectura (antes de la ventana de activación)

Con autorización de lectura del propietario para ese destino y esa sesión, conectar como el `postgres` de producción y ejecutar, una consulta cada vez:

```sql
SELECT current_user, current_setting('cron.timezone', true);
```

y después el bloque 1 de `diagnose.sql`. **DETENER y consultar al propietario** si ocurre cualquiera de estas situaciones; no relajar la guarda ni conceder privilegios para superarla:

- `current_user` no es `postgres`.
- Error `42501` (`permission denied to examine "cron.timezone"`): el rol no tiene `pg_read_all_settings` y `activate.sql` abortaría con el mismo error. Es un fallo cerrado, no un permiso que se deba conceder por rutina. En el bloque 1 de `diagnose.sql`, la columna `can_read_all_settings` lo indica sin abortar y las columnas `cron_*` salen `NULL`.
- La zona devuelta es `NULL` (pg_cron no precargado) o no es `GMT`, `UTC`, `Etc/UTC` ni `Etc/GMT`.

## Secuencia de activación (§10.2)

**Cada paso de escritura siguiente requiere autorización expresa del propietario para acción, entorno y población.** La aprobación del diseño no es autorización productiva.

1. Aplicar PR-1 mediante el procedimiento de migración autorizado y superar las puertas anteriores. No ejecutar SQL de cron dentro de una migración Prisma.
2. Solo después, publicar y desplegar la API con PR-2 mediante el procedimiento de release autorizado. Sin filas congeladas, se mantiene el respaldo actual. Desplegar no programa jobs.
3. Con autorización de lectura, comparar los recuentos de la vista previa con el calendario del Admin. El constructor es `STABLE` y no escribe:

   ```sql
   SELECT count(*) FILTER (WHERE (b.basis->>'assigned')::boolean) AS asignados,
          count(*) AS total
   FROM public.users u
   CROSS JOIN LATERAL (
     SELECT public.exom_adherence_day_basis(
       u.id, (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date - 1
     ) AS basis
   ) b
   WHERE u.role = 'CLIENT'
     AND u.created_at < (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date::timestamp;
   ```

4. Instalar pg_cron y los permisos de §5.1 como **paso separado autorizado**. Las sentencias están comentadas al principio de `activate.sql`: no se ejecutan automáticamente ni se deben descomentar como parte de la programación. Revisar necesidad y alcance de los `GRANT`; no ampliar privilegios de otros roles. El cuerpo de activación exige la extensión previamente instalada. Comprobar su versión, `cron.database_name`, registro de ejecuciones habilitado y `cron.timezone` GMT/UTC; las horas de abajo no son hora local española.
5. Obtener autorización expresa para el job principal, el reintento y la limpieza global aprobados en P6(a). **Los tres jobs se autorizan y programan juntos: no existe un modo «solo el principal».** Ejecutar `activate.sql` completo solo cuando las tres autorizaciones estén cubiertas; si el propietario autoriza menos, no ejecutarlo y consultar. Programa exactamente la tabla siguiente en una transacción: elimina previamente por nombre los jobs existentes y los vuelve a crear. No congela datos inmediatamente. Un fallo revierte la transacción; resolverlo antes de reintentar, sin continuar tras un error.
6. Revisar con el diagnóstico los tres nombres, comandos, horarios, `active=true`, usuario `postgres` y base prevista. Esperar a la primera ejecución de las 00:05 UTC. No se recomienda una ejecución manual inicial: fuera del margen de dos horas congelaría ayer como `late`.

**Primera noche.** Con la tabla vacía, `exom_freeze_adherence_day_bases_at` calcula `v_first = min(date)` = `NULL` y `v_from = GREATEST(hoy - 7, COALESCE(v_first, v_to))` (migración l.178-179), es decir, `v_from = v_to` = ayer: **solo se congela el día anterior**, nunca siete noches de atrás. Los objetivos (l.185-198) son los CLIENT con `created_at` anterior al final de ese día, con `ON CONFLICT DO NOTHING`. La recuperación de hasta siete noches se aplica **una vez iniciada la cobertura**: desde entonces `v_first` es la fecha mínima almacenada y cada ejecución cubre `[GREATEST(hoy - 7, v_first), ayer]`. Si en la primera noche no hay CLIENT elegibles, la tabla sigue vacía y la cobertura no se inicia.

**Solapamiento y duración.** El reintento de 01:05 UTC se ejecuta **aunque el principal de 00:05 siga en curso**: pg_cron no impide ejecuciones simultáneas de jobs distintos (se esperarían por la clave primaria, con `ON CONFLICT DO NOTHING`, o fallarían con `55P03` tras `lock_timeout` de 35 s). Tras la primera noche, comprobar la duración de las ejecuciones con una consulta de solo lectura:

```sql
SELECT j.jobname, d.status, d.start_time, d.end_time, d.end_time - d.start_time AS duration
FROM cron.job_run_details d
JOIN cron.job j ON j.jobid = d.jobid
WHERE j.jobname IN ('exom-adherence-day-freeze', 'exom-adherence-day-freeze-retry')
ORDER BY d.start_time DESC
LIMIT 10;
```

Si la duración del principal supera el umbral que fije el propietario (esta guía no propone un valor), **detenerse y consultar antes de la siguiente noche**. Retirar un job (`deactivate.sql` o `cron.unschedule`) **no cancela una ejecución ya en curso**: comprobar las ejecuciones activas antes y después.

| Nombre exacto | Cron (UTC) | Comando almacenado | Plan |
| --- | --- | --- | --- |
| `exom-adherence-day-freeze` | `5 0 * * *` | `SELECT public.exom_freeze_adherence_day_bases()` | §5.3, §10.2.5 |
| `exom-adherence-day-freeze-retry` | `5 1 * * *` | `SELECT public.exom_freeze_adherence_day_bases()` | §5.4, §10.2.6, P6(a) |
| `exom-cron-history-cleanup` | `30 0 * * *` | `DELETE FROM cron.job_run_details WHERE end_time < now() - interval '30 days'` | §5.4, §10.2.6, P6(a) |

La limpieza afecta al historial de **todos** los jobs de pg_cron, no solo a adherencia. No borra bases congeladas ni jobs. **No borra filas con `end_time` NULL** (la comparación es falsa para NULL): esas filas se acumulan indefinidamente, de forma lenta; cambiarlo requeriría una regla distinta, revisada aparte, que excluya ejecuciones activas. Guardar evidencia operativa saneada antes de la retención. Reejecutar la activación no duplica jobs, pero renueva sus `jobid`: conservar antes la relación nombre/id si se necesita consultar el historial antiguo, que permanece hasta su limpieza. `activate.sql` y `deactivate.sql` se serializan con `pg_advisory_xact_lock(20261118005)` (la misma clave en ambos, liberada al terminar la transacción); aun así, no lanzarlos desde varias sesiones a la vez. Los nombres quedan reservados a esta operación bajo `postgres`; la visibilidad de `cron.job` depende del rol y no acredita jobs ocultos de otros usuarios.

## Diagnóstico y criterio de éxito (§10.3)

`diagnose.sql` contiene exclusivamente consultas de lectura. **Ejecutarlo consulta a consulta**: el editor SQL de Supabase solo muestra el último resultado y se detiene en el primer error. Con psql, envolverlo en `BEGIN TRANSACTION READ ONLY; SET LOCAL statement_timeout = '15s'; …; ROLLBACK;`. El bloque de cron (el último) no se ejecuta si pg_cron no está instalado. Ejecutar primero el bloque 1: informa extensión instalada y versión, rol, superusuario/BYPASSRLS, `statement_timeout` de la sesión, propietarios, RLS/FORCE, privilegios y políticas. Si falta PR-1, no ejecutar el bloque 2; si falta pg_cron, no ejecutar el bloque 3. No interpretar una consulta rechazada como cobertura cero.

- El bloque 2 empieza con el recuento total de filas de `adherence_day_bases` (`total_rows`, plan §10.2.1; una tabla recién creada da 0) y compara los últimos 14 días cerrados UTC con los CLIENT actuales creados antes del final de cada día; incluye recuentos `scheduled`/`late`, capturas y huecos de las últimas siete noches. No filtra bloqueados, pendientes de identidad, inactivos ni archivados (P1).
- El bloque 3 muestra los tres jobs esperados, incluidos los ausentes, y sus siete últimas ejecuciones por `jobid` actual. Revisar `status`, comienzo y fin. **`return_message` contiene la etiqueta del comando (p. ej. `1 row`), no el JSON de recuentos** que devuelve la función: los recuentos de lo congelado salen del bloque de cobertura del bloque 2, no de `cron.job_run_details`. Las funciones de congelación limitan los errores al SQLSTATE; no volcar otras consultas con datos personales.
- «Corrió bien» exige una ejecución `succeeded` hoy UTC **y** cobertura completa de ayer, con una fila `scheduled` por cliente elegible. El reintento exitoso con cero inserciones es normal. Una ejecución exitosa con filas `late` no acredita captura puntual de noches anteriores.

Los recuentos usan la población actual, no reconstruyen usuarios eliminados ni roles históricos. El inicio de cobertura es `min(date)` global. Antes de la primera fila, la primera ejecución solo cubre ayer; los días previos no son huecos recuperables por defecto. Los campos `first_frozen_date` y `recoverable_by_default` distinguen esa situación. Con cero clientes elegibles puede no haber filas y el inicio seguir sin establecerse.

## Recuperación (§10.4)

Toda recuperación escribe y **requiere autorización expresa del propietario** para la acción, el entorno y la población de todos los CLIENT. Leer primero el SQLSTATE y corregir la causa (privilegios, RLS, esquema, bloqueos o disponibilidad); no ocultarla con grants generales.

```sql
SELECT public.exom_freeze_adherence_day_bases();
```

La llamada normal recupera hasta siete noches, nunca antes de la primera fecha almacenada. Es todo o nada e idempotente: las filas existentes no cambian. Solo ayer, dentro de las primeras dos horas UTC según el reloj real, queda `scheduled`; las demás filas nuevas son `late`. Se fija el estado leído en la recuperación, **no** se reconstruye la pauta original. `scheduled` se muestra como `original`; `late`, como estimado (`current_fallback`), pero ya estable (P2/P3).

Para una interrupción de más de siete noches, los días anteriores siguen en respaldo. Solo tras autorización específica se puede ampliar el rango, hasta 31 días y respetando el inicio de cobertura; sustituir `N` por el entero expresamente autorizado (no ejecutar literalmente):

```sql
SELECT public.exom_freeze_adherence_day_bases_at(now(), p_catchup_days => N);
```

Firma real: `exom_freeze_adherence_day_bases_at(p_now timestamptz, p_catchup_days integer DEFAULT 7, p_on_time_grace interval DEFAULT '2 hours') RETURNS jsonb`. La llamada sin argumentos también devuelve JSON con `from`, `to`, `targets`, `inserted` y `late`. No falsear `p_now` ni ampliar el margen para etiquetar recuperación como puntual. Una tabla vacía no permite recuperar retroactivamente 31 días: solo empieza por ayer.

## Pausa, retirada y reversión (§10.5)

Cada acción siguiente **requiere autorización expresa del propietario** para acción, entorno y población.

- **Pausa de congelación:** revisar los ids con el diagnóstico y pausar tanto principal como reintento; dejar uno activo no pausa la congelación. Para cada `jobid` verificado: `SELECT cron.alter_job(job_id := ID_VERIFICADO, active := false);`. La limpieza es independiente: pausar también su id si la autorización la incluye. Los marcadores no son SQL ejecutable. No cambiar otros jobs.
- **Retirada de los tres jobs:** ejecutar `deactivate.sql` completo. Es transaccional e idempotente. **Solo exige pg_cron instalado y el rol efectivo `postgres`**: no necesita la tabla ni las funciones, así que funciona también tras un rollback de la migración. Si falta pg_cron o el rol es otro, aborta con excepción clara. No exige RLS inactiva, para permitir retirar jobs ante ese fallo. Retira, por `jobid`, todos los jobs con los tres nombres exactos de la tabla de arriba cuyo usuario sea el rol efectivo, sea cual sea su base. Un job con esos nombres de **otro rol** no se toca: se emite un `WARNING` que lo nombra y la retirada termina con éxito; revisarlo aparte. No elimina funciones, extensión, tabla, filas ni historial. Las filas ya congeladas se siguen leyendo en la evaluación aunque se retiren los jobs (plan §10.5: `scheduled` se muestra como original y `late` como estimado, ya estables); solo los días nuevos vuelven al respaldo actual. Un job ya en ejecución puede terminar: retirar no equivale a cancelar una transacción en curso. Verificar ejecuciones activas antes y después.
- **Reversión de lectura:** desplegar una API sin U2 mediante el procedimiento autorizado. Ignora las bases diarias; la precedencia heredada v1 publicada permanece y los demás días vuelven al respaldo actual. Las revisiones append-only y las filas congeladas permanecen. Detener los jobs requiere la acción separada anterior.
- No ejecutar `DROP EXTENSION`, borrar bases congeladas, desactivar triggers de snapshots ni retirar tablas. Son acciones destructivas o de otro alcance, no una reversión prevista aquí.

## Límites y verificación pendiente

Se acepta la ventana 00:00 UTC → captura: una edición confirmada antes de la sentencia puede entrar en la base. Las dietas se guardan por referencia; **conservar los triggers y filas de `diet_day_snapshots`** de los días referenciados. No confundirlos con los triggers de journals que PR-4 podrá deshabilitar tras medición y autorización.

El SQL real de PR-1 prevalece sobre el esbozo del plan: `lock_timeout='35s'`, no 10 s; el bloqueo FK puede esperar al mutex por cliente de la API (`FOR UPDATE`, hasta 30 s), no solo al borrado. La etiqueta puntual usa `GREATEST(p_now, transaction_timestamp())`, evitando que un reloj inyectado antiguo fabrique `scheduled`. También valida margen no nulo y no negativo. El `CHECK` del payload usa `IS NOT DISTINCT FROM` para rechazar claves ausentes. No se cambian funciones en U3.

No se añade otra prueba §8.8: la suite `test/adherence-day-freeze.pg-spec.ts`, ya registrada en `PG_SUITES`, prueba directamente las funciones sin pg_cron.

## Estado de validación de los scripts

Ensayados el 2026-11-18 **solo en contenedores Docker locales desechables** (PostgreSQL 17.12 con pg_cron 1.6 del repositorio PGDG), con las migraciones aplicadas mediante `prisma migrate deploy`. Nunca contra una base real.

**Probado en local:**

- Con superusuario `postgres`: activación repetida sin duplicados (tres jobs exactos), job de otro rol intacto, retirada repetida, rol incorrecto, sin pg_cron, zona no UTC y retirada tras `DROP` de tabla y funciones.
- Retirada con un job propio en otra base y con un job homónimo de otro rol (se retiran los propios, se deja el ajeno y se emite `WARNING`).
- Concurrencia: dos sesiones forzadas a solaparse (activar+activar, activar+desactivar, desactivar+desactivar) terminan sin error y con 3 jobs o 0.
- Con un `postgres` NOSUPERUSER, BYPASSRLS y propietario de tablas y funciones (aproxima §12 bis U0), con `GRANT USAGE ON SCHEMA cron` y `GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA cron`: el comando de los jobs, la limpieza, `diagnose.sql` completo en transacción de solo lectura, `deactivate.sql` y `activate.sql` con FORCE RLS en una tabla de lectura.
- **Hallazgo:** sin `pg_read_all_settings`, `current_setting('cron.timezone', true)` falla con `42501` para ese rol y `activate.sql` aborta (fallo cerrado). Con ese rol concedido en el contenedor, la activación pasa. Es la razón del paso previo de solo lectura.
- Con datos mínimos (un CLIENT con asignación de ayer): el comando del job insertó filas la primera vez y 0 la segunda; pg_cron ejecutó de verdad un job de prueba cada minuto con `succeeded` y `return_message` = `1 row`. La limpieza borró solo la fila con `end_time` antiguo y conservó la de `end_time` NULL.

**NO verificado en producción:** si el `postgres` de Supabase puede leer `cron.timezone` (`pg_read_all_settings`); la versión real de pg_cron y sus privilegios sobre el esquema `cron`; `cron.timezone`, `cron.database_name` y registro de ejecuciones reales; la visibilidad de jobs ajenos; la duración con el volumen real de clientes; los horarios efectivos; la limpieza sobre el historial real. No ejecutar suites ni conectarse a producción por seguir esta guía.
