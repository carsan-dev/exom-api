# Compatibilidad FORCE RLS: corrección local y recuperación condicionada

**No ejecutar una reparación en producción con esta guía como autorización.** La corrección permite una captura completa cuando el propietario efectivo ya tiene visibilidad sin RLS (por ejemplo, BYPASSRLS legítimo), aunque la tabla tenga FORCE RLS. No concede privilegios, modifica políticas, desactiva RLS ni reconstruye historia anterior. La aplicabilidad a producción sigue condicionada a acreditar el rol efectivo de Prisma y recuperar el error original.

## Qué está confirmado y qué falta

- Base del código: `89e23bcff55af2fafc3bb13beb883bbf8543bc86`, rama `feat/progreso-adherencia-p4`, sin upstream configurado.
- Incidente comunicado: Prisma P3009 para `20261001040000_adherence_history_baseline`, sin `finished_at` ni `rolled_back_at`, `applied_steps_count = 0`; el usuario informa que las dos tablas nuevas están ausentes. Esto **no sustituye** comprobar el rollback completo.
- Ocho fuentes tienen FORCE RLS y propietario `postgres`: diets, exercises, ingredients, meal_ingredients, meals, plan_assignments, training_exercises y trainings. No se ha acreditado que la conexión efectiva de Prisma sea ese propietario con BYPASSRLS.
- El SQL antiguo rechaza ese estado incluso para un propietario NOSUPERUSER BYPASSRLS. La prueba local recupera `42501` directamente de SQL85. Prisma local puede mostrar solamente «current transaction is aborted» tras el error inicial; no conocemos el primer error del servidor de producción. Un bloqueo anterior también podría haber causado el fallo comunicado.
- La posible caída del backend no está confirmada. El arranque Node directo del Dockerfile no demuestra cómo opera el pipeline de la plataforma ni si existe un gate de migraciones. Para diagnosticar el endpoint, solicitar únicamente logs que el usuario pueda pegar y sanear; no hacer consultas remotas ni leer secretos del servidor.

## Cambio mínimo y frontera de seguridad

Las cinco condiciones de visibilidad en migraciones85, 87 y90 usan ahora `pg_catalog.row_security_active(c.oid)` en el contexto efectivo de `current_user`. Permanecen el propietario exacto de tablas, secuencia y funciones, los locks, constraints, transacciones y fuentes completas. La función trigger90 evalúa su contexto SECURITY DEFINER; las activaciones87/90 conservan el contexto invoker. No se concede BYPASSRLS dentro de las migraciones.

| Contexto efectivo | Resultado esperado |
| --- | --- |
| Propietario BYPASSRLS o superusuario, con FORCE RLS | Captura completa autorizada por privilegios ya existentes |
| Propietario normal, sin FORCE RLS | Captura completa; conserva compatibilidad anterior |
| Propietario sin bypass, con FORCE RLS activo | Rechazo42501 antes de asignar secuencia o escribir captura |
| No propietario, incluso con BYPASSRLS | Rechazo por identidad de propietario |
| `row_security=off` pero RLS activo | No es bypass; sigue rechazando |

Los guards de los journals privados, ledger y cortes en83/84/86/88 no se editan. No se usa FORCE como indicador suficiente de filtrado ni se aceptan capturas parciales. Las tres tablas overlay están incluidas en90. Los epochs originales de13 fuentes no adquieren retrospectivamente cobertura16: el marcador completo se crea en una nueva activación.

## Checksums: modificación explícita de migraciones existentes

Es una enmienda local autorizada y mínima de bytes de migraciones cuyo éxito sólo se conoce localmente; producción tiene85 fallida. Una92 aditiva no puede ejecutarse detrás de85 bloqueada. Los resultados históricos locales con los bytes anteriores siguen siendo históricos, **no** revalidaciones de los nuevos bytes.

SHA256 de `migration.sql` (sin cambios en las otras88 migraciones):

| Migración | Antes | Después |
| --- | --- | --- |
| `20261001040000_adherence_history_baseline` | `bb1f7559958e86635ffe6d7facdd6411528cb537dce25007cfd7a2d5f9b87540` | `45fc91cd37609a187cd2c31ca7e38b796315c92d55e3582f1b09fd470db28b29` |
| `20261002020000_adherence_live_origin_activation` | `a54538592424a77b2cbaf9209d7816c911953daed30c3c88efe95aaa4733f66d` | `885b3fe3b99faf7a1e6738391cabb212bef2540e1865c9a3d96b255427f1f7dc` |
| `20261002050000_adherence_effective_prescription_lineage` | `e48af834b8f4bd06bd0b7349e657bbc59995d643372dfe876996e80978cdfd30` | `c66f601978a093eda9b8a7ff406f426169d881e487a1f18543eb8666bca12227` |

**Si85, 87 o90 ya están aplicadas en cualquier DB persistente, detener el flujo de reparación fallida.** Se necesita un plan separado de reconciliación autorizado para esa DB y su historial. No ejecutar ciegamente las migraciones modificadas, editar checksums en `_prisma_migrations`, borrar sus filas ni marcar como aplicada una migración incompleta. La prueba local de recuperación sólo cubre85 realmente fallida y completamente revertida, no una DB persistente con bytes anteriores ya aplicados.

## Procedimiento del operador: puertas previas, no comandos de producción

La siguiente secuencia describe decisiones; deliberadamente no contiene un comando listo para ejecutar sobre producción.

1. **Identificar y autorizar el destino.** Registrar entorno, DB, población y acción precisa. Recuperar logs originales completos saneados, estado de Prisma y artefacto desplegado con sus hashes. Confirmar qué85/87/90 fueron aplicadas o fallaron. No inferir privilegios por el nombre `postgres` ni por una URI almacenada.
2. **Diagnóstico de sólo lectura autorizado.** Con la identidad que usa realmente Prisma, registrar `current_user`, `session_user`, `rolsuper`, `rolbypassrls`, propietario de DB/tablas/secuencia/funciones, RLS/FORCE, ACLs y políticas. Evaluar `row_security_active` para cada una de las13 fuentes y, donde corresponda, las tres overlays. Un reader distinto sin los mismos privilegios no prueba visibilidad de Prisma. Registrar conteos dependientes sin publicar datos personales. Si falta evidencia, mantener el estado desconocido.
3. **Protección y recuperación.** Obtener autorización separada para backup o acciones externas; verificar backup/PITR, punto de recuperación y ensayo de restauración antes de escribir. Esta tarea no ejecuta ni autoriza backups remotos. Conservar journals, snapshots, epochs, proofs, cuts, prescriptions y datos históricos; inventariar conteos y dependencias antes y después.
4. **Probar rollback de85.** Acreditar ausencia de ambas tablas `adherence_history_epochs` y `adherence_history_baselines`, ausencia de efectos parciales y escrituras de captura, estado íntegro de fuentes/journals y estado real de la fila fallida. `applied_steps_count = 0` o tablas ausentes por sí solos no prueban toda la garantía. Una duda o un objeto parcial exige un plan de reparación distinto; no improvisar borrados.
5. **Sólo después de autorización específica de acción y destino:** el operador puede resolver como rolled-back **únicamente** `20261001040000_adherence_history_baseline`, tras comprobar esas puertas. Después puede desplegar los bytes revisados con hashes acreditados, si esa ejecución también está autorizada. No resolver como applied, no editar el historial directamente, no conceder BYPASSRLS a roles reales ni cambiar FORCE/políticas para superar el guard. El éxito local no concede autorización remota.
6. **Verificar el resultado autorizado.** Comprobar inventario Prisma, checksums, todos los conteos/imágenes de13/16 fuentes, ownership, flags y políticas inalterados; comprobar servicio mediante un plan de verificación autorizado independiente. Un epoch nuevo acredita el estado observado, no un corte histórico anterior. Mantener proofs y periodos no acreditados como unknown.

## Regresión local reproducible

Runner: `node --test scripts/adherence-force-rls.spec.cjs`. Sin opt-in explícito falla antes de conectar: nunca recurre a DATABASE_URL, DIRECT_URL, PRISMA_DATABASE_URL, TEST_DATABASE_URL ni `.env`.

El launcher debe crear un PG17 nuevo con nombre `exom-force-rls-<UUID>`, label `exom.force-rls.nonce=<UUID>`, PGDATA `/var/lib/postgresql/exom-force-rls` en tmpfs, auto-remove y puerto dinámico **exclusivamente**127.0.0.1 (nunca55493). Debe escribir el mismo nonce como comentario de la DB administrativa. El test exige URI local explícita sin contraseña, nonce, ID exacto del contenedor y directorio temporal `C:/Users/croly/AppData/Local/Temp/exom-force-rls-<UUID>`; inspecciona identidad Docker y PostgreSQL antes de fixtureDDL. No usar aliases ni recursos anteriores. El entorno hijo tiene allowlist de variables no secretas de Windows; Prisma instalado se ejecuta con config temporal sin dotenv, sin instalación, generate o cambio de SDK/cache compartido.

Las concesiones BYPASSRLS y `pg_read_all_settings` ocurren únicamente en roles sintéticos del contenedor propio. Sus DB, configuraciones, logs y snapshots son desechables y quedan separados del repositorio. La limpieza requiere revalidar ID, nonce, nombre, imagen, PGDATA/tmpfs y puerto local; si falla el guard, entregar manifiesto al propietario sin actuar sobre otro recurso.

La matriz comprueba SQL85 original42501 y rollback,85 corregida13 imágenes completas,87 activación13,90/91 preservación de13 originales y nueva activación16 con marcador/conteos completos, trigger efectivo90 en overlay forzada, NOBYPASS, `row_security=off`, no propietario BYPASSRLS, NOFORCE normal, fresh91 y upgrade84→91. La recuperación fallida local reproduce P3009 y permite rolled-back solamente en la DB sintética propia tras comprobar rollback y ausencia de efectos; no prueba recuperación remota.

## Estado de entrega

Código y regresión locales preparados para revisión del padre. No commits, publicación, despliegue, conexión/SQL/grant/resolve remoto ni modificación de RLS real. La revisión nativa y el verificador independiente siguen pendientes. No reabrir ni reescribir evidencias anteriores para declarar este incidente resuelto en producción.
