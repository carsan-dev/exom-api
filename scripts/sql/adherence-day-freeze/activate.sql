-- Propósito: programar la congelación diaria, su reintento y la limpieza del historial.
-- Precondiciones: migración PR-1 aplicada, pg_cron instalado, zona GMT/UTC y rol
-- propietario postgres con visibilidad completa. Consultar el runbook antes de ejecutar.
-- Solo el propietario, con autorización expresa para la acción, entorno y población
-- (todos los CLIENT), puede ejecutarlo. ESCRIBE metadatos de cron; los jobs escribirán
-- bases congeladas y borrarán historial de TODOS los jobs con más de 30 días.

-- PASO SEPARADO (§10.2.4): ejecutar únicamente con su propia autorización expresa.
-- No forma parte de la transacción de programación y no se ejecuta automáticamente.
-- CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
-- GRANT USAGE ON SCHEMA cron TO postgres;
-- GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA cron TO postgres;

BEGIN;

DO $activation$
DECLARE
  signature text;
  relation_name text;
  job_name text;
BEGIN
  -- Serializa activate.sql y deactivate.sql: ambos usan esta misma clave fija
  -- (20261118005, ADH-FREEZE-01 PR-3). El bloqueo se libera al terminar la transacción.
  PERFORM pg_catalog.pg_advisory_xact_lock(20261118005);

  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'Congelación: se requiere el rol efectivo propietario postgres';
  END IF;
  IF to_regclass('public.adherence_day_bases') IS NULL THEN
    RAISE EXCEPTION 'Congelación: falta adherence_day_bases; aplicar primero la migración PR-1';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'pg_cron') THEN
    RAISE EXCEPTION 'Congelación: pg_cron no está instalado; requiere un paso autorizado separado';
  END IF;
  IF current_setting('cron.timezone', true) IS NULL
    OR current_setting('cron.timezone', true) NOT IN ('GMT', 'UTC', 'Etc/UTC', 'Etc/GMT') THEN
    RAISE EXCEPTION 'Congelación: verificar cron.timezone; se requiere GMT/UTC';
  END IF;

  FOREACH signature IN ARRAY ARRAY[
    'public.exom_adherence_unit_occurrences(text,date,text)',
    'public.exom_adherence_day_basis(text,date)',
    'public.exom_freeze_adherence_day_bases_at(timestamp with time zone,integer,interval)',
    'public.exom_freeze_adherence_day_bases()'
  ] LOOP
    IF to_regprocedure(signature) IS NULL THEN
      RAISE EXCEPTION 'Congelación: falta la función %; revisar la migración PR-1', signature;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc
      WHERE oid = to_regprocedure(signature)
        AND proowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
        AND NOT prosecdef)
      OR NOT has_function_privilege(current_user, signature, 'EXECUTE') THEN
      RAISE EXCEPTION 'Congelación: función % sin propietario postgres, invocador o permiso EXECUTE', signature;
    END IF;
  END LOOP;

  FOREACH relation_name IN ARRAY ARRAY[
    'public.users', 'public.plan_assignments', 'public.plan_assignment_trainings',
    'public.training_exercises', 'public.training_day_snapshots', 'public.adherence_day_bases'
  ] LOOP
    IF to_regclass(relation_name) IS NULL THEN
      RAISE EXCEPTION 'Congelación: falta la tabla %', relation_name;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class
      WHERE oid = to_regclass(relation_name)
        AND relowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user))
      OR pg_catalog.row_security_active(to_regclass(relation_name)) THEN
      RAISE EXCEPTION 'Congelación: tabla % sin propietario postgres o con RLS activa', relation_name;
    END IF;
  END LOOP;

  -- Los nombres son exclusivos de esta operación; no se usa un patrón exom-%.
  FOREACH job_name IN ARRAY ARRAY[
    'exom-adherence-day-freeze', 'exom-adherence-day-freeze-retry', 'exom-cron-history-cleanup'
  ] LOOP
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = job_name
      AND (username <> current_user OR database <> current_database())) THEN
      RAISE EXCEPTION 'Congelación: job % pertenece a otro rol o base; detener y revisar', job_name;
    END IF;
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = job_name) THEN
      PERFORM cron.unschedule(job_name);
    END IF;
  END LOOP;

  -- Plan §10.2.5 y §5.3: principal, 00:05 UTC.
  PERFORM cron.schedule('exom-adherence-day-freeze', '5 0 * * *',
    'SELECT public.exom_freeze_adherence_day_bases()');
  -- Plan §10.2.6, §5.4 y P6(a): reintento, 01:05 UTC.
  PERFORM cron.schedule('exom-adherence-day-freeze-retry', '5 1 * * *',
    'SELECT public.exom_freeze_adherence_day_bases()');
  -- Plan §10.2.6, §5.4 y P6(a): limpieza global del historial, 00:30 UTC.
  PERFORM cron.schedule('exom-cron-history-cleanup', '30 0 * * *',
    $$DELETE FROM cron.job_run_details WHERE end_time < now() - interval '30 days'$$);
END;
$activation$;

COMMIT;
