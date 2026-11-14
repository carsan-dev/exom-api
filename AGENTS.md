# exom-api: instrucciones para agentes

Este repo forma parte del workspace EXOM. El protocolo común es `../AGENTS.md` y debes leerlo antes de cambiar nada (Codex no lo carga por sí solo desde aquí).

## Repo

- Stack: NestJS 11, Prisma 7, PostgreSQL, Jest. Imagen Docker (`Dockerfile`).
- Rama base: `develop` (PR a `develop`; `main` es la release).

## Comandos (de `package.json`)

- Calidad: `npm ci`, `npm run prisma:generate`, `npm exec -- prisma validate`, `npm run prisma:format:check`, `npm run lint -- --no-fix`, `npm run build`, `npm run contract:check`.
- Tests: `npm test -- --runInBand` (Jest); `npm run test:adherence:off`, `npm run test:adherence:on`, `npm run test:e2e` y `npm run test:concurrency` necesitan PostgreSQL desechable.
- `npm run contract:update`, `npm run format` y `prisma:migrate` modifican archivos o la base: solo con petición expresa.
- Los scripts `identity:diagnose`, `db:audit-fks`, `streaks:recalculate` y `progress:repair-plan-edits` operan sobre datos: no los ejecutes contra un entorno real sin autorización.

## CI y despliegue

- CI (`.github/workflows/ci.yml`, Node 22.21.0, PostgreSQL 17 desechable): `npm ci`, `prisma:generate`, `prisma validate`, `prisma:format:check`, `lint -- --no-fix`, `build`, `contract:check`, comprobación de BD desechable (`node scripts/test-database.cjs`), `prisma migrate deploy`, tests de lanzadores, `test:adherence:off`, `test:adherence:on`, `test:e2e`, `docker build` y smoke (`node scripts/smoke-docker.cjs`).
- `supabase-backup.yml` hace un volcado cifrado diario y manual de la base de producción: no lo lances ni lo cambies sin petición.
- No leas ni imprimas `.env*`. La carpeta `%SystemDrive%` es un residuo ajeno al código: no la toques.

## Arnés (resumen de `../AGENTS.md`)

- Salida de tests/lint/build a un log fuera del repo; lee solo el resumen (Jest `Tests:|Test Suites:|FAIL`, ESLint `problem`, tsc `error TS`).
- Commits convencionales con ámbito y en español, sin atribución de IA ni `Co-Authored-By`; sin commit, push ni merge sin petición del propietario.
- Worktrees en `EXOM/exom-api-worktrees/<nombre>`, nunca en `/tmp`, con su propio `.codegraph/` y `npm ci`.
- Sin gentle-ai ni `.atl/skill-registry.md`. Archivos nuevos en LF (`tr -cd '\r' < fichero | wc -c` = 0).
