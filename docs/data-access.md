# Acceso a datos — Fase 8

Revisión 2026-09-12. Implementación local; **no desplegada**. ISSUE-004/P8-03 cerrado tras eliminación productiva acotada solicitada/aprobada, con copia recuperable y auditoría final; ver cierre posterior al final. Evidencia reproducible en la raíz de coordinación `docs/operations/phase8-20260912/`. No ejecutar las migraciones remotamente por el hecho de disponer de estos archivos.

## Contratos y consultas

`query-page.ts`, `catalog-page.ts` y `users-list-query.ts` ejecutan filtros, búsqueda, orden, OFFSET/LIMIT y COUNT en PostgreSQL. Solo los IDs de la página se hidratan en Prisma, dentro de la misma transacción RepeatableRead. Se mantiene la respuesta `{data, meta}`, los límites del DTO, los filtros opt-in y el orden con desempate por ID. El total sigue disponible en páginas vacías. No se promete una instantánea común entre distintas peticiones: inserciones/borrados entre páginas OFFSET pueden desplazar resultados, igual que antes. Con datos estables, los empates no producen omisiones o duplicados.

| Lector | Implementación y semántica preservada |
| --- | --- |
| Usuarios, clientes globales y clientes de administrador | Estado LOCKED antes que ACTIVE/INACTIVE; roles, nivel, fechas UTC inclusivas y archivados opt-in. Búsqueda en email + nombre + apellido, incluyendo coincidencias entre campos. Admin ordena por creación/ID de asignación activa; SuperAdmin por creación/ID de usuario. El filtro assigned/unassigned global exige administrador ADMIN activo; Admin mantiene su contrato previo de ignorarlo. Conteo de administradores activos mediante `_count` filtrado. |
| Dietas, entrenamientos, ingredientes | Búsqueda literal normalizada y filtros en SQL; orden y nulos equivalentes a Prisma. Dietas: tipo y badge deben coincidir en la misma comida. Entrenamientos: compatibilidad `type` y `types`. Ingredientes: WITH_ICON incluye cadena vacía porque el contrato previo era NOT NULL; WITHOUT_ICON acepta nulo o vacío. |
| Ejercicios | Uso calculado con `count(DISTINCT training_id)` de entrenamientos activos. Filtro used/unused y orden por uso/video antes de paginar. Vídeo vacío equivale a ausencia. Hidratación y conteos limitados a la página. |
| Feedback, recaps, retos Admin | Filtros relacionales de autorización y agregaciones, sin descargar todos los IDs de clientes accesibles. Se mantienen diferencias de rol/estado previas. Orden estable en las páginas modificadas. |
| Notificaciones seleccionadas | La comprobación de destinatarios consulta únicamente los IDs solicitados. El broadcast mantiene su instantánea durable de destinatarios. |
| Dashboard | Conteo semanal, permisos, desempate por nombre español e ID y top cinco en SQL. Nombre visible conserva trim y fallback a email. |

El inventario AST completo registra `findMany`, `filter`, `slice`, método, ubicación y argumentos. `findMany` sin `take` no implica automáticamente descarga global: quedan hidrataciones por IDs de una página, detalles de una entidad, lecturas históricas por cliente/ventana, catálogo completo y escritores/reconciliadores con contrato de conjunto completo. No se añade un límite silencioso que pierda histórico o trabajo. El feed del dashboard mezcla como máximo cuatro fuentes de diez filas y devuelve diez; su `slice` no pagina una población ilimitada. El `slice` del borrado durable procesa un inventario persistido por lotes; los demás son cadenas/argumentos. Se conservan los protocolos F5–F7, sin ampliar esta fase a rediseñar su trabajo durable.

## Normalización e indexabilidad

`exom_normalize_search` usa lower español ICU, NFD y elimina marcas combinantes solo después de vocales, como el código anterior. Conserva ñ y ç. `strpos` conserva los literales `%`, `_` y `\`; no convierte el término en un patrón SQL. No se usa `unaccent` genérico porque cambiaría esas equivalencias. La función no necesita backfill. PostgreSQL debe disponer de ICU y base UTF-8.

Se estudió GIN `pg_trgm` sobre una proyección normalizada combinada: ensayo sintético de 25 filas 0,021→0,019 ms; 10.000 filas 1,145→0,028 ms, índice de 1.015.808 bytes y construcción de unos 92 ms. Es un límite inferior del coste de consulta: no incluye mantenimiento ni backfill. Producción tiene 25 usuarios en la auditoría del 12/09. No existe beneficio suficiente allí para añadir una segunda representación sincronizada entre users/profiles, triggers e índice. Los índices separados de email/nombre no conservan coincidencias que cruzan campos. La consulta real combinada sobre 10.000 usuarios sintéticos sigue alrededor de 65–74 ms; trasladarla a SQL limita memoria/red, pero no elimina su escaneo. Reconsiderar la proyección si mediciones de consultas reales muestran ese coste repetido y significativo, preservando todos los escritores de email/perfil y el contrato literal.

Los índices trigram soportan LIKE/ILIKE; `strpos` no obtiene esa aceleración automáticamente. Un cambio futuro requeriría escapar patrones y probar de nuevo caracteres especiales. Fuentes: [PostgreSQL pg_trgm](https://www.postgresql.org/docs/17/pgtrgm.html), [índices de expresiones](https://www.postgresql.org/docs/17/indexes-expressional.html).

## Índices medidos

`measure.cjs` ejecuta cinco EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON), mediana, sobre fixtures aislados en una transacción revertida. Son tiempos locales, no predicciones de latencia productiva. Población: 10.000 usuarios, 100.000 notificaciones, 50.000 feedbacks, 20.000 usos y fixtures de los otros seis modelos. SQL y planes íntegros en `measurement.json`.

| Modelo/consulta real | Decisión | Mediana antes→después (ms) |
| --- | --- | --- |
| User por rol, creación, ID y LIMIT | Añadir `(role,created_at,id)` | 2,651→0,021 |
| Notification por destinatario, creación, ID | Añadir `(recipient_id,created_at,id)`; el índice con read_at intermedio no cubre el orden global | 1,004→0,029 |
| FeedbackMedia por cliente, creación, ID | Añadir `(client_id,created_at,id)` | 0,666→0,029 |
| TrainingExercise, uso por ejercicio | Añadir `(exercise_id,training_id)` | 2,800→0,291 |
| PlanAssignment por cliente/fecha | Conservar UNIQUE `(client_id,date)` y los índices de regla/dieta | 0,063→0,059 |
| DayProgress por cliente/ventana | Conservar UNIQUE `(client_id,date)` | 0,088→0,044 |
| ChallengeClient por cliente/estado/fecha | Conservar `(client_id,is_completed,assigned_at)` y los de challenge/source | 0,031→0,027 |
| BodyMetric por cliente/fecha | Conservar `(client_id,date)` | 0,029→0,024 |
| AutoAssignmentRule por cliente/activa/vigencia | Conservar `(client_id,is_active,starts_on,ends_on)` | 0,048→0,036 |
| AdminClientAssignment por admin/activa/fecha/ID | Conservar `(admin_id,is_active,created_at,id)` y UNIQUE admin/cliente | 0,029→0,026 |

Las variaciones de las consultas sin índices nuevos son ruido/caché entre mediciones; no se atribuyen a una optimización. No se eliminan índices antiguos sin medir todos sus lectores/escritores.

## Pool y TLS

El adaptador Prisma utiliza el único `pg.Pool` de `PrismaService`, también compartido por los jobs que fijan transacciones. No crear un segundo pool para sortear sus límites. `PRISMA_DATABASE_URL` sigue siendo override exclusivo del CLI de Prisma; no reemplaza la URL runtime.

| Variable runtime | Default | Validación |
| --- | --- | --- |
| DATABASE_POOL_MAX | 10 | Entero >=1 |
| DATABASE_POOL_IDLE_TIMEOUT_MS | 10000 | Entero >=0; 0 desactiva expulsión por inactividad |
| DATABASE_POOL_CONNECTION_TIMEOUT_MS | 10000 | Entero >=1; limita adquisición/conexión, no duración de SQL |
| DATABASE_SSL_MODE | verify-full | verify-full, require o disable; require también verifica certificado/nombre; disable solo fuera de NODE_ENV=production |
| DATABASE_SSL_CA | Trust store de Node | PEM de CA confiable cuando el servidor lo requiera; no archivo de clave privada |

Máximo numérico 2.147.483.647; valores vacíos, fraccionarios o inválidos fallan. Dimensionar `réplicas × max` con margen para CLI, administración y conexiones fijadas por jobs, dentro del presupuesto PostgreSQL/proxy. No aumentar max indiscriminadamente: medir espera de adquisición, conexiones activas/ociosas y carga. Prueba real con max=2 demuestra timeout del tercer cliente, recuperación al liberar y expulsión ociosa. El cierre de Nest libera también el pool externo; readiness hace una consulta real y falla de forma genérica sin imprimir URL.

La URL no puede sobrescribir max/timeouts ni rebajar TLS. Opciones URL ssl/sslcert/sslkey/sslrootcert se rechazan: configurar la política por las variables anteriores. `NODE_TLS_REJECT_UNAUTHORIZED=0` se rechaza en producción. Se comprueban cadena y hostname incluso con dirección IP, caso que el comportamiento SNI de pg no cubría por sí solo. Errores de conexión/pool y logs de Prisma no vuelcan consultas o credenciales. `DATABASE_SSL_MODE=disable` sirve únicamente para el PostgreSQL local de pruebas.

Pruebas TLS con servidor PostgreSQL simulado a nivel de SSLRequest y handshake real: CA no confiable rechazada; CA confiable con hostname incorrecto rechazada; fallo de arranque cierra el pool y devuelve mensaje seguro. En la auditoría productiva, cliente→pooler usa TLS cifrado y autorizado. `pg_stat_ssl=false` describe pooler→backend, no ese socket cliente; no se afirma cifrado de ese segundo tramo. Las opciones de sesión por URL del pooler no prueban modo read-only: cada auditoría usa BEGIN READ ONLY explícito.

Referencias: [pg.Pool](https://node-postgres.com/apis/pool), [TLS y opciones de conexión](https://node-postgres.com/features/ssl), [dimensionamiento y liberación](https://node-postgres.com/features/pooling).

## Migraciones y recuperación

1. `20260912170000_search_normalization`: collation ICU y función inmutable, sin reescritura de filas.
2. `20260912171000_data_access_indexes`: cuatro índices B-tree, transacción, lock_timeout 5 s, statement_timeout 120 s.
3. `20260912172000_validate_assignment_foreign_keys`: valida las cuatro FK históricas NOT VALID en una transacción con los mismos timeouts; no repara ni borra datos.

La creación estándar de índices toma lock SHARE y puede bloquear escrituras mientras construye. El límite de espera hace fallar de forma segura ante actividad incompatible; no promete cero interrupción. Para una población mayor que la medida, preparar una estrategia CONCURRENTLY separada con comprobación de índices inválidos antes de autorizar despliegue; no cambiar silenciosamente este SQL transaccional. VALIDATE CONSTRAINT toma SHARE UPDATE EXCLUSIVE en la tabla origen y ROW SHARE en la referenciada. El ensayo de contención real obtuvo 55P03, sin índices parciales, y el retry tras liberar el lock pasó. Referencias: [CREATE INDEX](https://www.postgresql.org/docs/17/sql-createindex.html), [VALIDATE CONSTRAINT](https://www.postgresql.org/docs/17/sql-altertable.html).

Preflight: identificar destino, revisar migraciones/checksums, capacidad ICU/UTF-8, tamaño y actividad de tablas; ejecutar `npm run db:audit-fks` con variables del entorno ya cargadas. El auditor abre RepeatableRead READ ONLY y devuelve conteos por cada FK pública, no IDs ni PII. Exit 2 indica huérfanos/FK requerida ausente; exit 1 indica fallo de configuración/conexión. La existencia de FK NOT VALID no es exit 2 si todos los datos cumplen: la validación queda como paso separado.

Con huérfanos, **no aplicar la tercera migración**. Obtener fuente histórica fiable, preparar diagnóstico/plan de recuperación por identidad y conservar asignaciones, fechas, relaciones, progreso y snapshots. No inventar usuarios, convertir admin_id a NULL ni borrar filas para validar. Cualquier reparación productiva necesita propuesta revisable, respaldo/recuperación y autorización de acción, entorno y población. Tras reparar con autorización, repetir auditoría y autorizar VALIDATE; comprobar las cuatro convalidated=true y todos los conteos a cero.

Ante fallo transaccional: verificar rollback real y estado de `_prisma_migrations`; solo entonces marcar la migración fallida como rolled-back mediante Prisma y reintentar tras resolver la causa, con autorización remota correspondiente. No editar checksums de migraciones aplicadas. Los pasos anteriores ya confirmados permanecen aunque falle el tercero. Para rollback de aplicación es preferible conservar los objetos aditivos. En pruebas se revirtió la validación a NOT VALID, se retiraron exclusivamente los cuatro índices y función/collation nuevos y se compararon esquema y filas con la base: todo conservado.

La prueba `migrations.cjs` cubre esquema nuevo (72 migraciones), actualización 69→72 con histórico legacy, fallo esperado 23503 con cuatro referencias huérfanas, atomicidad sin validación parcial, preservación completa y recuperación con identidades originales **sintéticas**. Esa recuperación de fixtures no constituye permiso ni solución a los huérfanos reales.

## Auditoría FK y límite productivo

PlanAssignment ya tiene FK para client_id, admin_id, training_id, diet_id y auto_assignment_rule_id; sus enlaces ordenados también tienen FK. No se añade una FK duplicada ni se altera su onDelete. ADR-001/007 y el histórico de dietas/RIR se preservan. El inventario de IDs escalares sin FK distingue IDs de proveedor, claves de operación, referencias polimórficas, snapshots históricos y recibos/operaciones durables que sobreviven al recurso. `created_by` de catálogos/retos/logros y `reviewed_by` de feedback conservan su atribución histórica; añadir una FK no resolvería propietarios ausentes y requiere definir retención al eliminar un administrador. No se introduce cascada destructiva por apariencia del nombre de una columna.

Producción PostgreSQL 17.6, 2026-09-12: 51 constraints auditadas; ninguna requerida ausente. 47 validadas sin huérfanos; las cuatro históricas NOT VALID:

| Constraint | Referencias huérfanas | Identidades distintas |
| --- | --- | --- |
| plan_assignments_client_id_fkey | 133 | 8 |
| plan_assignments_admin_id_fkey | 33 | 2 |
| auto_assignment_rules_client_id_fkey | 2 | 1 |
| auto_assignment_rules_admin_id_fkey | 0 | 0 |

Los grupos pueden solaparse; no son 168 personas ni necesariamente 168 filas distintas. Asignaciones de cliente afectadas entre 04/03 y 31/08/2026; de admin entre 04/03 y 12/04; reglas desde 13/07. No se consultaron nombres/emails ni se modificó producción. La revisión de migraciones remotas confirma la base hasta `20260912140000_streak_calculation_date`; las tres nuevas siguen locales. ISSUE-004/P8-03 permanecen BLOCKED hasta recuperar identidades con evidencia y validar en producción con autorización. El SQL falla deliberadamente ante esos datos; no desplegar Fase 8 hasta resolver su preflight.

## Cierre posterior autorizado — 2026-09-12 16:31 UTC

La auditoría anterior y sus huérfanos son el diagnóstico previo, conservado como evidencia. Tras conocerlos, el usuario pidió eliminarlos y aprobó la operación concreta con copia recuperable y validación de FK. Se retiraron 133 planes distintos, dos reglas y 120 enlaces dependientes; todos de clientes ausentes, sin progreso/snapshots ni asignaciones de clientes actuales afectados. Las 33 referencias de admin estaban dentro de los mismos 133 planes.

Se conserva copia íntegra de 255 filas y constraints originales en `exom_recovery`, batch `phase8-orphans-20260912`. Fingerprints verificados; los roles anon/authenticated/service_role no tienen acceso al esquema. Copia, borrado y VALIDATE de las cuatro FK se confirmaron en una transacción con locks/timeouts y barreras de población. Auditoría posterior: 51 FK validadas, cero huérfanos. Producción conserva 25 usuarios, 1434 planes y 70 reglas. Las 69 migraciones previas coinciden por checksum. La aplicación y las tres migraciones F8 siguen sin desplegarse; VALIDATE será idempotente al aplicarse posteriormente.

ADR-023 registra la excepción limitada solicitada y sustituye únicamente el bloqueo de recuperación de estos huérfanos descrito arriba; no autoriza eliminar otros registros ambiguos. Prueba de restauración completa, aborto por cliente actual/fingerprint y rollback intermedio: `recovery-test.json` PASS. Procedimiento y autorización en `docs/operations/phase8-20260912/RECOVERY.md`; no borrar la copia ni restaurar producción sin nueva autorización.
