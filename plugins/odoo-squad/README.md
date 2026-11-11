# odoo-squad

Squad de agentes autónomos para Odoo. Le das una tarea documentada y la lleva a cabo de principio a fin: planifica, implementa, prueba, corrige y verifica en staging de Odoo.sh, y aprende del proyecto. Usa las salvaguardas, el estado y la memoria de `odoosh-browser`, que es **requisito**.

## Uso

```powershell
claude plugin install odoosh-browser@odoo-agent-plugins
claude plugin install odoo-squad@odoo-agent-plugins
```

En un repo de módulos con `/odoosh-browser:odoo-project-setup` ya hecho:

```
/odoo-squad:squad-run tarea.md        # o una descripción en texto
```

## Agentes

| Agente | Modelo | Función |
|---|---|---|
| `squad-planner` | sonnet | plan con criterios de aceptación; rectifica si falla el enfoque |
| `squad-implementer` | sonnet | código y tests según el plan |
| `squad-tester` | sonnet | pruebas locales y en Odoo.sh; devuelve evidencias |
| `squad-fixer` | sonnet | causa raíz y corrección mínima de los fallos |
| `squad-advisor` | opus | solo consultas: decisiones complejas, bloqueos, acciones irreversibles |
| `squad-writer` | haiku | resumen, descripción del PR y borradores de mensajes al cliente (nunca envía nada) |

Los modelos son alias (`sonnet`, `opus`, `haiku`) que apuntan a la última versión; se cambian en el frontmatter de cada agente.

El orquestador es la skill `squad-run` (hilo principal), porque un subagente no puede lanzar otros. Solo el orquestador escribe en `.oap/`, hace commit y push.

## Flujo

```
tarea → planner → implementer → tester(local) → commit/push staging → tester(remote)
                                   │ fallo                                  │ fallo
                                   └──────────► fixer ◄─────────────────────┘
                                   (máx. 3 ciclos; advisor si hay bloqueo) → verifier → writer → informe
```

## Autonomía

Por defecto el push a staging pide confirmación. Para saltarla **solo en staging** en un proyecto: `config.js set-autonomy auto` (vía `oap.js config set-autonomy auto`, pide confirmación). Producción sigue denegada siempre. Detalle en la documentación de `odoosh-browser`.

## Memoria

Comparte `.oap/memory.md` con `odoosh-browser`, y su hook de memoria (recordatorio de anotar hallazgos) actúa también durante `squad-run` porque el estado de la tarea usa el mismo `run.json`. Estado propio en `.oap/odoo-squad/` (`plan.md`, `tasks/`).

## Pendiente (próximas versiones)

- Entorno local: Postgres global (Docker, config en `~/.oap/`, bases desechables con prefijo `oap_`) y código fuente de Odoo para ejecutar tests antes del push.
- Verificar en una sesión real que los alias de modelo resuelven a la última versión y que el hook `Stop` no duplica avisos con subagentes.

## Desarrollo

`npm test` (en esta carpeta) y `claude plugin validate .\plugins\odoo-squad`.
