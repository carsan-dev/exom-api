# Contratos HTTP y generación de transporte

Revisión exclusiva Fase10, 2026-09-13. [Arquitectura autoritativa](../../docs/architecture.md), [inventario legacy y FEAT-007](legacy-contracts.md), [evidencias](../../docs/operations/phase10-review-20260913/WORK.md).

## Fuente y verificación

La fuente de comportamiento sigue siendo controllers, DTOs/ValidationPipe, guards, servicios, serialización y persistencia. [openapi.json](openapi.json) es una descripción derivada y revisable del HTTP, no una autoridad que permita cambiar el comportamiento para acomodar un generador. Swagger usa la misma fábrica `src/openapi.ts` que exporta el fichero en CI.

Diagnóstico reproducido: 202 operaciones registradas en 163 rutas; 169 sin esquema de éxito y 26 campos validados de DTO sin documentación. El compilador encuentra además un controller raíz antiguo no registrado: no se publica su ruta. Los DTOs desnudos y varios POST200 del documento anterior no coincidían con el interceptor ni con el status por defecto de Nest. La regresión demuestra que el esquema antiguo de tags rechaza la respuesta real y el actual la acepta.

`scripts/infer-response-contracts.cjs` comprueba el programa de producción (`tsconfig.build.json`), obtiene tipos retornados por handlers y genera esquemas de transporte descriptivos. Representa Date como string date-time, uniones, arrays/intersecciones, nulabilidad y campos opcionales. No escribe modelos de dominio ni modifica lógica ejecutable. Los 28 puntos de tipo abierto (`openTypes` en `src/contracts/response-contracts.json`) corresponden a JSON persistido o tipos abiertos existentes: no afirman una estructura más precisa que el código. Son un inventario revisable, no prueba de compatibilidad de todos los posibles datos JSON históricos.

La fábrica usa metadatos de handlers realmente registrados para rutas, método, status, seguridad pública y aprobación. Añade la envoltura de `TransformInterceptor`, el error de `AllExceptionsFilter` y las propiedades validadas de DTO. Un campo validado sin esquema hace fallar la exportación. `IsOptional` admite tanto ausencia como null; se representa incluso alrededor de refs/enums. Se documentan límites de arrays/números/texto, los tipos temporales/RIR y condiciones entre campos conocidas. Las reglas dependientes de datos (propiedad, versiones, catálogo o longitud de excepciones RIR respecto del ciclo) siguen siendo validación del servicio y se describen como rechazo HTTP; OpenAPI no puede decidirlas sin estado.

ISSUE-074: la revisión amplía el inventario a tipos de parámetros reflejados, incluidos DTOs privados declarados en controllers, y corrige primitivas anulables que la reflexión de TypeScript emitía como Object. `IsString`, `IsNumber`, `IsBoolean`, `IsArray`, `IsObject` e `IsNotEmpty` completan sus formas y límites. La subida de fichero de sesión declara multipart/form-data y campo binario file requerido. Regresiones HTTP comprueban campos textuales que el servidor acepta pero el esquema anterior rechazaba, bytes inválidos en DTO local y fichero requerido. No cambia la conversión implícita del ValidationPipe ni la autorización de subidas.

El esquema no valida una petición de negocio en nombre del servidor. La inferencia TypeScript tampoco prueba casts, triggers ni interceptores. Por ello la suite HTTP usa AppModule real, ValidationPipe, interceptor, guards de roles, servicios y PostgreSQL aislado. Sustituye exclusivamente la identidad Firebase por una identidad sintética; las peticiones anónimas recorren el guard original. Prueba envelope, tags, live, 400/401, create/detail/list/day, prescripción temporal/legacy, trim, null, 202 y 204. Las suites existentes cubren conflictos, permisos, recibos, histórico, replay y concurrencia. No se afirma haber llamado exhaustivamente las 202 operaciones contra datos reales.

## Comandos y gate de deriva

En `exom-api`, después de instalar el lock y generar Prisma:

```sh
npm run contract:update
npm run contract:check
npm run test:e2e
```

`contract:update` infiere, construye y exporta. `contract:check` compara tipos/registro de DTOs y documento estable sin reescribirlo; CI lo ejecuta después del build y ejecuta e2e sobre DB desechable. Cambiar source o decorators sin actualizar el contrato produce fallo. Cambiar un valor de negocio manteniendo su tipo requiere una regresión HTTP/servicio: ningún diff estático demuestra todas las semánticas. El ensayo `drift-probe.cjs` agrega temporalmente una propiedad al retorno real de liveness y altera el documento por separado: ambos gates fallan, y los originales se restauran por hash. No se reduce el gate para aceptar esos fallos.

La exportación no llama `app.init`, no abre DB, no activa cron ni Firebase. Utiliza configuración sintética de metadatos. No descargar un OpenAPI de producción ni usar credenciales reales como requisito de generación.

## Reglas que debe mantener cualquier transporte

| Aspecto | Contrato |
| --- | --- |
| Respuesta | Éxito `{success:true,data,timestamp}`; POST201 salvo código explícito. DELETE204 no tiene cuerpo. 202 de aprobación no significa mutación realizada. |
| Fallo | `{statusCode,message,error,timestamp,path}` y solo extensiones públicas permitidas: `code`, recibo `operation_id`, revisión/progreso en conflicto. Preservar status y cuerpo; no convertir todo fallo en sesión inválida. |
| Fechas | JSON Date se serializa ISO; un día de planificación se envía como YYYY-MM-DD y los cálculos de semana/día usan las funciones UTC del backend. No convertir a día local mediante Date del navegador. |
| Nulabilidad | `undefined`/campo ausente conserva donde el comando es parcial; null puede borrar una configuración explícitamente. Una serialización que elimina todos los null rompe ese contrato. |
| Tiempo/RIR | Segundos canónicos, `timed_config` v1, rangos frente a totales exactos, unidad solo de presentación. RIR objetivo y realizado no se mezclan. Conservar 0, segundos, IDs de ocurrencia y datos por serie. |
| Sesión y reintento | Firebase/sesión/propietario/entorno/revisión de operación se mantienen en adaptadores existentes; la cola conserva misma identidad y formato entre reintentos. Un 409 exige política de conflicto; 423/429/5xx tienen tratamiento propio. |
| Medios | URLs de lectura pueden firmarse al serializar; no son identidad ni retención de evidencia. Una URL caducada no autoriza borrar un fichero pendiente. |

## Estudio de generación automática

Los candidatos oficiales son [typescript-axios](https://openapi-generator.tech/docs/generators/typescript-axios/) para Admin y [dart-dio](https://openapi-generator.tech/docs/generators/dart-dio/) para App. Son generadores de clientes; sus tablas de capacidades y opciones muestran que la combinación de uniones y nulabilidad debe probarse, no suponerse. Nest también documenta [límites de reflexión y esquemas explícitos](https://docs.nestjs.com/openapi/types-and-parameters). Consulta realizada el 2026-09-13; no se instala ni fija una versión del generador sin un ensayo reproducible.

Decisión ADR-025: conservar por ahora los transportes actuales. Una adopción posterior empezaría con endpoints pequeños de lectura, salida en un directorio `generated/transport`, versión/configuración exactas del generador y adaptadores explícitos a los modelos actuales. En TypeScript se reutilizaría la instancia Axios/interceptores; en Dart, el cliente Dio/sesión existente. Los modelos de formularios, entidades Flutter, caché Hive, persistencia de operaciones y UI quedan fuera de generación.

Para adoptar: generar dos veces y comparar salida; compilar con los locks actuales; contrastar contra los fixtures HTTP/legacy y fixtures de cola de versiones previas; comprobar null frente a ausencia, enums desconocidos, arrays/uniones, fechas, envelopes, aprobación y errores; verificar cancelación, renovación de identidad y replay estable. Tratar los 28 tipos abiertos con mapeo explícito, no casts que prometan tipos inexistentes. Si el generador no conserva estas reglas, limitarlo al transporte comprobado o mantener el adaptador manual. Esta fase acredita el estudio y la detección de deriva; no acredita un cliente generado desplegado ni añade una sustitución innecesaria del dominio.
