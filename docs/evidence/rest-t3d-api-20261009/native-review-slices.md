# U1/U2 — cierre local con excepción limitada de revisión

Fecha: 2026-10-09. Recibo pasivo en español; resultados comunicados por el padre, no ejecutados por este escritor. API en `feat/progreso-adherencia-p4`; no publicación ni despliegue. Los 21 paths de fuente/evidencia del checkpoint permanecen byte idénticos.

## Disposición

**U1 aprobado nativamente y ACK burned; U2 ALTERNATIVE PASS, NO aprobado nativamente.**
El usuario autorizó esta alternativa: «si no se puede no se puede, mientras puedas validar que esté bien».
Excepción exclusiva de U2: no desactiva RDD global ni omite revisión nativa de otros candidatos.
La selección posterior `continue_remaining_p5` permite continuar solo P5 después de registrar esta unidad; no PR/publicación/P6/despliegue/datos reales.

## Identidades locales preservadas

| Unidad | Base | Commit | Árbol | Superficie |
| --- | --- | --- | --- | --- |
| U1 | `a4a97d8dfc005a9b8d69e4cafac24e8e3163440a` | `5df3d14f7654f290f814fb1e8c42e23a4f344c50` | `24f63c053b34d75cc79066bd77e4e9bfc8be8062` | 14 paths, 192 líneas |
| U2 | `5df3d14f7654f290f814fb1e8c42e23a4f344c50` | `703e0f1fbde354b0589ed7fd9f1de56500b7ae37` | `fb38e3bf16eac5e370df11327036e708ce663bc3` | 7 paths |

U1: `review-5d034e6499413cda`, medium, única revisión consolidada `review-reliability`, APPROVED.
ACK consumido/burned: `sha256:4966a82074804936f8e6081cb2610cef29ad44e93df45cc290ff6b55333abf6a`.
Target: `sha256:f8aabcf9f4e1dc46a886b50a8d9e319bc4f84d0b8b1fbd5211a585f70e76c526`. No STATUS después del ACK.

U2: START PRE-AUTHORITY `lens_context_budget_exceeded`, sin autoridad; `review-0399fd2c30c9dde8` inactivo.
El selector agregado anterior `review-d0511f7bfb5851ec` también está inactivo. No STATUS/ACK/recovery/abandon/retry.
Gentle AI 4.0.0, última estable investigada: cap runtime real **204800 bytes**; sección OpenAPI **253380 bytes**.
No hay split soportado que admita ese archivo indivisible ni fix soportado encontrado. No cambiar límites ni truncar evidencia.

## Alternativa independiente — PASS autorizado

`gentle-ai-verify`, tarea `mv0vftwk-9-usrm`: PASS de los siete paths, incluido JSON generado íntegro y referencias semánticas.
18 sitios Swagger; validators runtime, nullabilidad y bounds intactos. 28 casos originales/79 expresiones expect preservados.
Dos flujos nuevos validan ocho respuestas HTTP con Ajv, DTO400 y privacidad; no se debilitaron assertions.

Comprobaciones **FRESH**, PASS exit0 según el padre (no rerun documental):

- `node node_modules/typescript/bin/tsc --project tsconfig.json --noEmit --incremental false --pretty false`
- `node node_modules/eslint/bin/eslint.js src/contracts/request-dtos.ts src/modules/client-followup-tasks/dto/client-followup-task.dto.ts src/modules/recaps/dto/review-publication.dto.ts test/contracts.e2e-spec.ts --no-fix`
- `node scripts/infer-response-contracts.cjs` (sin `--write`).
- `git diff 5df3d14f7654f290f814fb1e8c42e23a4f344c50 703e0f1fbde354b0589ed7fd9f1de56500b7ae37 --check`

Evidencia **REUSED autenticada, NO rerun**: 265 UNIQUE PASS =32+187+46; no atribuir e2e PASS a U1 aislado.
Build aislado: 5959 inputs declarados, grafo expandido 7634, normalización BOM/sourceMappingURL coincidente; export/repeat coincidente.
19 pins fuente, cuatro del usuario y cinco ajenos coinciden; índice/diff tracked vacíos antes de este recibo.
Manifest sellado SHA256 `5ff040afdb00070065a5e7229861ab9e90753a1b1c9a11fd313b5218b6b0fe4f`.
Aceptación final SHA256 `4f6f82b0b48bc65e4ed62560f71b1c4686ac7042b90cc130d038b6084b486a85`.

## Recibos originales intactos y límites

- [TSC-LEGACY-04](typescript-legacy-04.md), SHA256 `075ac31eb7f365ba99e65fd7e6ed98c8ff3c57ec0d16435f38928c9aff9f7ee9`.
- [Restauración canónica](contract-catalog-restoration.md), SHA256 `446c77c0c41ea685d059c3d58de8554079cb603879c9eab15653e1272724d5fe`.
- Log automático Pi: 393574 bytes, SHA256 `851782480056babf2cbbd658dcdef2ac1140799468c0cbeee3328f03c5ec3eb7`, preservado; no volcar rutas privadas.

Suite completa1377 NOT_RUN en este candidato; auditoría histórica de artefactos NOT_COMPLETED; Firebase/JWT live, despliegue y cierre final P5 no acreditados.
REST-T3D-API-01 IN_PROGRESS por otros criterios; reconciliación y aceptación final pendientes, siete estados feature intactos.
Siguiente selección REST-T2B-FU-02: bulk opuesto multifila, aceptación pendiente antes de cierre P5, no deuda perpetua.
No bug probado ni rewrite de producción antes de RED causal; mapa read-only, test acotado, runner PG aislado auditado y revisión independiente/nativa propia.
Este escritor solo registra documentación: sin escrituras intencionales de fuente, lecturas secretas, tests/builds, recursos, autoridad nativa ni Git mutante.
Espejo completo de tarea en Engram PENDING: copia íntegra y lectura de vuelta aún no completadas; la observación operativa no equivale al documento completo.
