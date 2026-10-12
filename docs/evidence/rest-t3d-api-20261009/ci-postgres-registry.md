# PostgreSQL de CI: espejo oficial fijado

Criterio: REST-P5-CI-REGISTRY-01; corrección causal de la inicialización de CI, sin cambios de producto.

## Motivo y alcance

El run [37994040241](https://github.com/carsan-dev/exom-api/actions/runs/37994040241), intentos 1 y 2, falló al inicializar contenedores antes del checkout: timeouts de autenticación de Docker Hub y límite de descarga anónima. Ninguna comprobación de código ejecutada en esos intentos acredita PASS.

Solo se sustituye `services.postgres.image` por el [espejo oficial documentado por Docker](https://www.docker.com/blog/news-from-aws-reinvent-docker-official-images-on-amazon-ecr-public/), sin credenciales. Permisos, triggers, runner, salud, variables, puertos y comprobaciones permanecen byteexactos.

## Verificación local — 2026-10-09

- PASS: consulta y descarga anónimas con configuración Docker vacía propia; manifiesto linux/amd64, base `debian:bookworm-slim`, versión anunciada `17.11-bookworm`.
- Descriptor fijado: `sha256:66aafa11cf15800a3c94763f7e11d1e7b2e37e5e84bc4ce027cb6e1e4bfaf4df`.
- Configuración OCI anunciada: `sha256:589f742565e4f6d22149176b032974f55f8201a8a37b71ed587ec5c6902e689f`.
- PASS: sonda efímera propia, solo lectura, sin red ni bootstrap DB: PostgreSQL `17.11 (Debian 17.11-1.pgdg12+2)`; sistema `bookworm`; `PG_MAJOR=17`.
- La imagen previamente almacenada declara el mismo paquete `17.11-1.pgdg12+2`, pero su identificador difiere. No se afirma identidad binaria; se conserva major, patch y distribución verificados.
- RED estructural: el campo original no coincidía con el descriptor verificado. GREEN: campo nuevo correcto y todos los demás bytes del workflow iguales; diff y árbol limitado a este campo y este recibo.
- NOT_RUN: suites locales, Prisma y DB; no acreditan un cambio de registro. CI remoto del nuevo commit permanece pendiente de publicación y ejecución, sin reutilizar aprobación nativa anterior.

## Mantenimiento y rollback

El digest evita cambios silenciosos de la etiqueta; actualizarlo requiere verificar de nuevo la imagen. La reversión se limita al campo de imagen y este recibo, pero reintroduciría la dependencia de Docker Hub observada. La corrección debe conservarse en los siguientes prefijos API antes de publicarlos, sin alterar la segmentación aprobada.
