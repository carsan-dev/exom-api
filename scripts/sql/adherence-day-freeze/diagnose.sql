-- Propósito: diagnosticar extensión, privilegios, jobs y cobertura sin datos personales.
-- Precondiciones: autorización de lectura y rol propietario postgres; para los bloques
-- de cobertura, PR-1 aplicada; para el último bloque, pg_cron instalado.
-- Solo el propietario, con autorización expresa para la acción, entorno y población
-- (todos los CLIENT), puede ejecutarlo. NO ESCRIBE: únicamente SELECT de catálogo
-- y recuentos. Si falta una dependencia, ejecutar solo los bloques aplicables.
-- Ejecución: consulta a consulta (el editor SQL de Supabase solo muestra el último
-- resultado y se detiene en el primer error) o con psql dentro de
-- BEGIN TRANSACTION READ ONLY; SET LOCAL statement_timeout = '15s'; ... ROLLBACK;

-- 1. Independiente de PR-1 y pg_cron: ejecutar primero y detenerse si faltan objetos.
SELECT version() AS postgres_version, current_database() AS database,
       session_user, current_user, r.rolsuper, r.rolbypassrls,
       current_setting('TimeZone') AS session_timezone,
       current_setting('statement_timeout') AS statement_timeout,
       pg_catalog.pg_has_role(current_user, 'pg_read_all_settings', 'member') AS can_read_all_settings,
       -- Los parámetros cron.* solo son legibles con pg_read_all_settings; sin él, el
       -- CASE devuelve NULL en lugar de abortar el bloque (NULL no acredita GMT/UTC).
       CASE WHEN pg_catalog.pg_has_role(current_user, 'pg_read_all_settings', 'member')
         THEN current_setting('cron.timezone', true) END AS cron_timezone,
       CASE WHEN pg_catalog.pg_has_role(current_user, 'pg_read_all_settings', 'member')
         THEN current_setting('cron.database_name', true) END AS cron_database,
       CASE WHEN pg_catalog.pg_has_role(current_user, 'pg_read_all_settings', 'member')
         THEN current_setting('cron.log_run', true) END AS cron_log_run
FROM pg_catalog.pg_roles r WHERE r.rolname = current_user;

SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'pg_cron') AS installed,
       (SELECT extversion FROM pg_catalog.pg_extension WHERE extname = 'pg_cron') AS installed_version,
       (SELECT default_version FROM pg_catalog.pg_available_extensions WHERE name = 'pg_cron') AS available_version;

SELECT names.name, c.oid IS NOT NULL AS present,
       pg_catalog.pg_get_userbyid(c.relowner) AS owner,
       c.relrowsecurity, c.relforcerowsecurity, c.relacl,
       CASE WHEN c.oid IS NOT NULL THEN pg_catalog.row_security_active(c.oid) END AS rls_active_for_me,
       CASE WHEN c.oid IS NOT NULL THEN has_table_privilege(current_user, c.oid, 'SELECT') END AS can_select
FROM (VALUES ('users'), ('plan_assignments'), ('plan_assignment_trainings'),
             ('training_exercises'), ('training_day_snapshots'), ('diet_day_snapshots'),
             ('adherence_day_bases')) names(name)
LEFT JOIN pg_catalog.pg_namespace n ON n.nspname = 'public'
LEFT JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid AND c.relname = names.name
ORDER BY names.name;

SELECT names.signature, p.oid IS NOT NULL AS present,
       pg_catalog.pg_get_userbyid(p.proowner) AS owner,
       p.prosecdef AS security_definer, p.provolatile, p.proconfig,
       CASE WHEN p.oid IS NOT NULL THEN has_function_privilege(current_user, p.oid, 'EXECUTE') END AS can_execute
FROM (VALUES
  ('public.exom_adherence_unit_occurrences(text,date,text)'),
  ('public.exom_adherence_day_basis(text,date)'),
  ('public.exom_freeze_adherence_day_bases_at(timestamp with time zone,integer,interval)'),
  ('public.exom_freeze_adherence_day_bases()')
) names(signature)
LEFT JOIN pg_catalog.pg_proc p ON p.oid = to_regprocedure(names.signature);

-- Privilegios efectivos; la presencia de SELECT no acredita visibilidad bajo RLS.
SELECT r.rolname, r.rolsuper, r.rolbypassrls,
       CASE WHEN to_regclass('public.adherence_day_bases') IS NOT NULL
         THEN has_table_privilege(r.oid, to_regclass('public.adherence_day_bases'), 'SELECT') END AS can_select,
       CASE WHEN to_regprocedure('public.exom_freeze_adherence_day_bases()') IS NOT NULL
         THEN has_function_privilege(r.oid, to_regprocedure('public.exom_freeze_adherence_day_bases()'), 'EXECUTE') END AS can_freeze
FROM pg_catalog.pg_roles r
WHERE r.rolname IN (current_user, 'postgres', 'anon', 'authenticated', 'service_role')
ORDER BY r.rolname;

SELECT schemaname, tablename, policyname, permissive, roles, cmd
FROM pg_catalog.pg_policies
WHERE schemaname = 'public' AND tablename = 'adherence_day_bases';

-- 2. Requiere PR-1 y visibilidad completa. Total global de filas congeladas (plan §10.2.1):
-- una tabla recién creada debe dar cero; si no, registrar la cobertura sin vaciarla.
SELECT count(*) AS total_rows, min(date) AS first_date, max(date) AS last_date
FROM public.adherence_day_bases;

-- Comparar con CLIENT actuales creados antes del final UTC de cada día; no reconstruye
-- usuarios eliminados ni cambios de rol.
WITH dates AS (
  SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date - i AS date
  FROM generate_series(1, 14) i
)
SELECT d.date, count(u.id) AS expected_client_days, count(b.client_id) AS frozen_client_days,
       count(u.id) FILTER (WHERE b.client_id IS NULL) AS missing_client_days,
       count(b.client_id) FILTER (WHERE b.provenance = 'scheduled') AS scheduled,
       count(b.client_id) FILTER (WHERE b.provenance = 'late') AS late
FROM dates d
LEFT JOIN public.users u ON u.role = 'CLIENT' AND u.created_at < (d.date + 1)::timestamp
LEFT JOIN public.adherence_day_bases b ON b.client_id = u.id AND b.date = d.date
GROUP BY d.date ORDER BY d.date DESC;

SELECT date, provenance, count(*) AS frozen_rows,
       min(captured_at) AS first_capture, max(captured_at) AS last_capture
FROM public.adherence_day_bases
WHERE date >= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date - 14
  AND date < (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date
GROUP BY date, provenance ORDER BY date DESC, provenance;

-- Huecos de las últimas 7 noches, incluidos días anteriores al inicio de cobertura.
-- recoverable_by_default=false no es un fallo: la función no retrocede antes del inicio.
WITH dates AS (
  SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date - i AS date
  FROM generate_series(1, 7) i
), coverage AS (
  SELECT min(date) AS first_frozen_date FROM public.adherence_day_bases
)
SELECT d.date, c.first_frozen_date,
       d.date >= COALESCE(c.first_frozen_date, (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date - 1)
         AS recoverable_by_default,
       count(u.id) FILTER (WHERE b.client_id IS NULL) AS missing_client_days
FROM dates d CROSS JOIN coverage c
LEFT JOIN public.users u ON u.role = 'CLIENT' AND u.created_at < (d.date + 1)::timestamp
LEFT JOIN public.adherence_day_bases b ON b.client_id = u.id AND b.date = d.date
GROUP BY d.date, c.first_frozen_date ORDER BY d.date DESC;

-- 3. Requiere pg_cron: no ejecutar este bloque si installed=false en el bloque 1.
-- Mostrar también un job esperado ausente; no enumerar jobs ajenos.
SELECT names.name AS expected_job, j.jobid, j.schedule, j.command, j.active, j.username, j.database
FROM (VALUES ('exom-adherence-day-freeze'), ('exom-adherence-day-freeze-retry'),
             ('exom-cron-history-cleanup')) names(name)
LEFT JOIN cron.job j ON j.jobname = names.name
ORDER BY names.name;

SELECT j.jobname, runs.status, runs.return_message, runs.start_time, runs.end_time
FROM cron.job j
LEFT JOIN LATERAL (
  SELECT d.status, d.return_message, d.start_time, d.end_time
  FROM cron.job_run_details d WHERE d.jobid = j.jobid
  ORDER BY d.start_time DESC NULLS LAST, d.runid DESC LIMIT 7
) runs ON true
WHERE j.jobname IN ('exom-adherence-day-freeze', 'exom-adherence-day-freeze-retry', 'exom-cron-history-cleanup')
ORDER BY j.jobname, runs.start_time DESC NULLS LAST;
