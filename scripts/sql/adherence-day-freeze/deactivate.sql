-- Propósito: retirar únicamente los tres jobs de activate.sql por su nombre exacto.
-- Precondiciones: pg_cron instalado y rol efectivo postgres; no requiere que existan la
-- tabla ni las funciones, para poder retirar los jobs tras un rollback.
-- Consultar el runbook antes de ejecutar.
-- Solo el propietario, con autorización expresa para la acción, entorno y población
-- (todos los CLIENT), puede ejecutarlo. ESCRIBE metadatos de cron; no elimina
-- bases congeladas, funciones, extensión ni historial de ejecuciones.
-- Retira, por jobid, todos los jobs con esos nombres cuyo usuario es el rol efectivo,
-- con independencia de su base. Un job con esos nombres de OTRO rol no se toca: se emite
-- un WARNING con su nombre y la retirada continúa.

BEGIN;

DO $deactivation$
DECLARE
  job record;
BEGIN
  -- Serializa activate.sql y deactivate.sql: ambos usan esta misma clave fija
  -- (20261118005, ADH-FREEZE-01 PR-3). El bloqueo se libera al terminar la transacción.
  PERFORM pg_catalog.pg_advisory_xact_lock(20261118005);

  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'Congelación: se requiere el rol efectivo postgres';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'pg_cron') THEN
    RAISE EXCEPTION 'Congelación: pg_cron no está instalado';
  END IF;

  -- No exigir RLS inactiva: se debe poder retirar los jobs tras un fallo de RLS.
  -- cron.unschedule(job_id bigint) existe en la versión instalada de pg_cron.
  FOR job IN
    SELECT j.jobid, j.jobname, j.database
    FROM cron.job j
    WHERE j.jobname IN ('exom-adherence-day-freeze', 'exom-adherence-day-freeze-retry',
                        'exom-cron-history-cleanup')
      AND j.username = current_user
    ORDER BY j.jobid
  LOOP
    PERFORM cron.unschedule(job.jobid);
    RAISE NOTICE 'Congelación: job % (jobid %, base %) retirado', job.jobname, job.jobid, job.database;
  END LOOP;

  FOR job IN
    SELECT j.jobid, j.jobname, j.username, j.database
    FROM cron.job j
    WHERE j.jobname IN ('exom-adherence-day-freeze', 'exom-adherence-day-freeze-retry',
                        'exom-cron-history-cleanup')
      AND j.username <> current_user
    ORDER BY j.jobid
  LOOP
    RAISE WARNING 'Congelación: job % (jobid %) pertenece a otro rol (%, base %); NO se toca, revisar manualmente',
      job.jobname, job.jobid, job.username, job.database;
  END LOOP;
END;
$deactivation$;

COMMIT;
