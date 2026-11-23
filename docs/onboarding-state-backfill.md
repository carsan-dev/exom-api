# Onboarding persistente: migración, backfill y recuperación

Plan: `docs/plans/onboarding-persistente-plan.md` (raíz EXOM), decisiones OP-D1, OP-D4, OP-D12 y OP-D13.

## Qué cambia

- Migración `20261123120000_profile_onboarding_state`: enum `OnboardingOutcome` (`COMPLETED`, `SKIPPED`) y dos columnas nullable sin default en `profiles`: `onboarding_completed_at TIMESTAMP(3)` y `onboarding_outcome`. No escribe datos; tras aplicarla todos los perfiles quedan sin marca.
- `POST /api/v1/profile/me/onboarding` (solo `CLIENT`): primera escritura gana con un único `UPDATE … WHERE onboarding_completed_at IS NULL` y lectura posterior; responde 200 con la marca persistida (también en reintentos), 403 a no clientes y 404 si no hay perfil (no lo crea). `outcome` ausente o `null` guarda `NULL` («desconocido»), reservado a la autoreparación desde la marca local heredada de la App.
- `GET /auth/me`, login, social, `GET/PUT /profile/me` y las vistas de Admin que incluyen el perfil exponen ambas claves. `PUT /profile/me` y `PATCH /admin/clients/:id/profile` no las escriben y rechazan (400) recibirlas.

## Backfill (separado de la migración)

Marca como ya onboardeados los perfiles `CLIENT` sin marca con actividad real: `fcm_token`, alguna fila en `day_progress` o alguna en `body_metrics`. Fecha = instante de la ejecución en UTC; `onboarding_outcome` queda `NULL`; `updated_at` no cambia. SQL: `scripts/sql/onboarding-state/backfill.sql`.

```bash
# Destino solo por esta variable; no hay fallback a DATABASE_URL ni a .env.
ONBOARDING_BACKFILL_DATABASE_URL=<url> node scripts/onboarding-state-backfill.cjs            # dry-run (por defecto)
ONBOARDING_BACKFILL_DATABASE_URL=<url> node scripts/onboarding-state-backfill.cjs --apply    # escribe
```

- `--dry-run` (por defecto) cuenta en una transacción `READ ONLY` y no escribe: `{"mode":"dry-run","eligible":N,"by_signal":{"fcm_token":…,"day_progress":…,"body_metrics":…}}`. Un perfil con varias señales cuenta una vez en `eligible` y una vez en cada señal.
- `--apply` ejecuta el `UPDATE` en una transacción con `lock_timeout = 5s` y añade `"affected":N`. Es idempotente: una segunda ejecución da `affected: 0`. Si falla (SQLSTATE `55P03` por fila bloqueada, red…) no confirma nada y puede repetirse.
- La salida solo contiene recuentos o un SQLSTATE; nunca URL, credenciales, identificadores ni datos personales.
- Concurrencia con el endpoint: PostgreSQL reevalúa el predicado tras esperar el bloqueo de fila, así que nunca sobrescribe una marca del `POST` ni produce dos fechas (probado en `src/modules/profile/profile-onboarding.concurrency.spec.ts`).
- Para un destino remoto, la URL debe exigir TLS (`sslmode=require` o superior) según la política de ese entorno.

**Autorización.** Ejecutar `--apply` (o la migración) contra un entorno real requiere autorización expresa que cubra acción, entorno y población. Orden previsto: migración → dry-run (registrar recuentos) → `--apply` → validación, todo antes de publicar la versión de la App que lee el estado del servidor (si la App nueva llega antes, un cliente sin marca local va a Inicio y no ve el onboarding hasta que la API exponga el campo).

## Diagnóstico

Recuentos de solo lectura (sin datos personales):

```sql
SELECT count(*) FILTER (WHERE onboarding_completed_at IS NULL) AS sin_marca,
       count(*) FILTER (WHERE onboarding_outcome = 'COMPLETED') AS completed,
       count(*) FILTER (WHERE onboarding_outcome = 'SKIPPED') AS skipped,
       count(*) FILTER (WHERE onboarding_completed_at IS NOT NULL AND onboarding_outcome IS NULL) AS desconocido
  FROM profiles;
```

El dry-run del script da los perfiles que el backfill marcaría en ese momento.

## Recuperación

- Backfill aplicado por error o sobre más población de la debida: no hay deshacer automático porque no distingue fechas del backfill de las de la autoreparación (ambas con `outcome NULL`). Antes de `--apply`, guardar el recuento del dry-run y, si se exige reversibilidad fina, una copia `CREATE TABLE … AS SELECT id, onboarding_completed_at, onboarding_outcome FROM profiles` con autorización. Las marcas con `COMPLETED`/`SKIPPED` proceden siempre del endpoint.
- Retirar la migración: `scripts/sql/onboarding-state/rollback.sql` (elimina ambas columnas, el tipo y el registro en `_prisma_migrations`, en una transacción; un `prisma migrate deploy` posterior la vuelve a aplicar). **Destruye todas las marcas** y solo es válido antes de publicar la App que lee el estado del servidor. Orden obligatorio: primero desplegar la versión anterior de la API y después ejecutar `rollback.sql`; con la API nueva desplegada, `include: { profile: true }` pediría las columnas borradas y fallarían login y `/auth/me`. Requiere la misma autorización que cualquier cambio de datos reales.

## Validación local

Solo contra el cluster desechable `exom_ci` verificado por `scripts/test-database.cjs`:

```bash
node scripts/validate-onboarding-state-migration.cjs   # fresh + upgrade con fixtures F1..F9 + dry-run/apply/idempotencia + restore
node --test scripts/onboarding-state-backfill.test.cjs # puertas del script, sin base de datos
```

El validador crea y borra sus propias bases `exom_ci_onboarding_(upgrade|fresh|restore)_<12 hex>`, aplica las migraciones previas tal como están y deja a `prisma migrate deploy` solo la migración objetivo. Ejecuta el backfill con `TimeZone` de sesión `Europe/Madrid` para comprobar que guarda instantes UTC como Prisma.
