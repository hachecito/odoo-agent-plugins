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

Por defecto el push a staging y el JavaScript en Chrome piden confirmación, también cuando los lanza un subagente; si nadie responde, la tarea se queda parada. Por proyecto se puede subir el nivel con `oap.js config.js set-autonomy auto|yolo` (pide confirmación):

- `auto`: el push simple a staging deja de preguntar.
- `yolo`: además, Chrome (incluido JavaScript en dominios permitidos), los scripts del plugin y `ssh` de lectura a builds de staging.

Producción, force push y demás denegaciones siguen igual en cualquier nivel. Detalle en la documentación de `odoosh-browser`.

Los subagentes no pueden hacer commit ni push: el guard lo deniega y solo el orquestador los hace.

## Memoria y tareas

```
.oap/
  memory.md                         lecciones reutilizables (compartida con odoosh-browser)
  odoo-squad/tasks/
    index.md                        una línea por tarea: id · estado · título
    20261112-campo-referencia/
      task.md                       la tarea tal como se entregó
      plan.md                       plan del planner (y sus rectificaciones)
      hallazgos.md                  detalles que solo valen para esta tarea
```

- El planner lee siempre `memory.md` y el índice, y solo abre la carpeta de una tarea anterior si está relacionada.
- La memoria guarda solo lo que sirve en otras tareas, etiquetado por tema.
- `scripts/tasks.js` crea las carpetas, mantiene el índice y migra el formato 0.1.0 (`tasks migrate`).
- El hook de memoria de `odoosh-browser` (recordatorio de anotar hallazgos) actúa también durante `squad-run`.

## Pendiente (próximas versiones)

- Entorno local: Postgres global (Docker, config en `~/.oap/`, bases desechables con prefijo `oap_`) y código fuente de Odoo para ejecutar tests antes del push.
- Comprobar en una sesión real que el `allow` del modo `yolo` evita las preguntas de los subagentes en segundo plano.

## Desarrollo

`npm test` (en esta carpeta) y `claude plugin validate .\plugins\odoo-squad`.
