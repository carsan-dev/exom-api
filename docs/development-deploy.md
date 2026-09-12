# Desarrollo, CI e imagen de ejecución

## Entornos

`.env.example` contiene únicamente valores de desarrollo y placeholders. Desarrollo usa PostgreSQL local, CORS localhost y proyectos Firebase/R2 de prueba. Staging requiere base, proyecto Firebase, bucket, remitente de email y cuentas propios; `NODE_ENV=production` también en staging para mantener las garantías TLS y no servir Swagger/uploads locales. Producción usa sus recursos independientes. No copiar credenciales productivas como fallback, ni inferir aislamiento del nombre de una variable.

La URL API de los clientes incluye `/api/v1` en Flutter; Admin añade ese prefijo a `VITE_API_URL`. El helper Android y los destinos dev/staging/prod están documentados en `exom-app/docs/environments-and-release.md`. CORS debe contener solo los orígenes del entorno. Las migraciones y reparaciones reales son operaciones separadas de construir o publicar una imagen.

## Checks reproducibles

CI ejecuta `npm ci`, generación/validación/formato de Prisma, `npm run lint -- --no-fix`, build, todos los tests, concurrencia y e2e. No hay baseline ni excepción de lint. El formatter de Prisma instalado no ofrece `--check`; `npm run prisma:format:check` formatea una copia temporal y compara, sin escribir el schema. Para editar deliberadamente: `node scripts/check-prisma-format.cjs --write`, seguido de revisión del diff.

El servicio PostgreSQL desechable de CI usa rol/base `exom_ci` y PGDATA `/var/lib/postgresql/exom-ci-data`. `TEST_DATABASE_URL` debe apuntar a 127.0.0.1 con puerto explícito, sin parámetros que cambien el destino. Antes de migrar o crear fixtures se comprueban identidad y directorio reales. No existe fallback a DATABASE_URL. Las suites de integración rechazan casos omitidos, informes incompletos y recursos abiertos; requieren al menos los 211 casos de concurrencia y los 10 HTTP vigentes. Al añadir casos, revisar esos mínimos; no reducirlos para obtener verde.

Ejecutar las suites y el smoke **secuencialmente** sobre un cluster reservado para esa ejecución. Una API externa ejecutando su scheduler sobre el cluster de tests puede consumir fixtures de durable work. CI crea un servicio propio por job y solo arranca la imagen después de las suites. No conectar ninguna API de desarrollo a ese cluster.

## Docker y probes

`npm run build` genera `dist/src/main.js`; Docker y `start:prod` usan esa ruta. La imagen multi-stage conserva únicamente dist, dependencias de producción y package.json. `npm prune --omit=dev --omit=optional` retira también los peers opcionales Prisma CLI/TypeScript. El cliente Prisma se genera antes de podar dependencias. El runner usa `node` (no root), permite escribir en uploads y recibe SIGTERM directamente; Nest cierra aplicación, scheduler y pool. La imagen no incluye herramientas para ejecutar migraciones: se ejecutan desde un job con dependencias de desarrollo y autorización/destino propios.

* `GET /api/v1/health/live`: proceso HTTP responde, sin comprobar servicios externos.
* `GET /api/v1/health/ready`: bootstrap completado y consulta real `SELECT 1` PostgreSQL; devuelve 503 al fallar o empezar el cierre. Usa timeout de consulta de 2 s más espera de conexión limitada por `DATABASE_POOL_CONNECTION_TIMEOUT_MS` (10 s por defecto). No certifica Firebase, FCM, R2 ni email.
* Ambas respuestas mantienen el envelope global `{ data: { status } }`. El endpoint legacy `/api/v1/public/healthchk` conserva su contrato.

El HEALTHCHECK de Docker usa readiness. `node scripts/smoke-docker.cjs IMAGE` verifica ruta, usuario, ausencia de herramientas de build, HTTP y salida normal tras SIGTERM contra el cluster desechable. Siempre recoge el contenedor; una ejecución incompleta falla. Su modo test permite PostgreSQL local sin TLS; el runner conserva por defecto NODE_ENV=production y exige TLS verificado en producción.

Para comprobar también el modo producción contra un PostgreSQL **de prueba con TLS**, suministrar su CA pública en `SMOKE_DATABASE_SSL_CA`. El smoke mantiene las mismas restricciones de aislamiento y pasa `DATABASE_SSL_MODE=verify-full` al contenedor. No usar una CA o credencial productiva como sustituto del cluster de prueba.

## Compatibilidad de herramientas (ISSUE-008)

El lockfile actual combina Prisma/adapter-pg 7.10.0 con pg 8.20.0. La traza del aviso `client.query()` concurrente nace en el intérprete de transacciones Prisma (`PgTransaction.performIO/queryRaw`), no en una regla de lint. pg 8 mantiene la cola; pg 9 anuncia retirarla. npm ci fija la versión probada y el rango pg `^8.20.0` no admite pg 9. No actualizar a pg 9 sin soporte del adapter y repetir concurrencia real, cierre de pools y e2e. El aviso permanece visible; no se presenta como eliminado. El build Android con Flutter 3.41.5, AGP 8.11.1 y Gradle 8.14 no reprodujo los avisos históricos SDK XML/Gradle. Son garantías de estas versiones, no una autorización para actualizar dependencias por rutina.

## Publicación

No existe workflow de release API en este repositorio (backup no publica código). Un workflow futuro debe llamar a `./.github/workflows/ci.yml`, depender de su éxito y publicar la imagen construida de ese mismo SHA, sin reconstruir otra rama. Los servicios de hosting externos no quedan configurados por añadir YAML: antes de habilitar auto-deploy deben exigir checks del commit que despliegan. Esta fase no modifica ajustes remotos ni publica imágenes.

Referencias: [multi-stage Docker](https://docs.docker.com/build/building/multi-stage/), [Prisma format](https://docs.prisma.io/docs/cli/v7/format).
