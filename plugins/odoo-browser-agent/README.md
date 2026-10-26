# odoo-browser-agent

Plugin de Claude Code para completar tareas de Odoo de principio a fin sobre una **rama staging de Odoo.sh**: código y tests, commit, push con confirmación, verificación del build, logs y tests en el build, e informe final con evidencias.

No incluye extensión de navegador ni MCP propios. Combina:

| Necesidad | Herramienta |
|---|---|
| Código, commits, push | git local |
| Estado del build | commit status que Odoo.sh publica en GitHub (MCP `github` o `gh`) |
| Logs, `odoo-update`, tests en el build | SSH o terminal del editor web de Odoo.sh |
| Páginas de Odoo.sh con sesión iniciada | [Claude in Chrome](https://code.claude.com/docs/en/chrome) |
| Dudas sobre Odoo | context7 + código fuente de Odoo |
| Salvaguardas | hook `PreToolUse` determinista (`scripts/guard.js`) |

## Contenido

```
plugins/odoo-browser-agent/
  .claude-plugin/plugin.json
  skills/odoo-task/                     orquestador end-to-end
  skills/odoo-project-setup/            config por repo, rama staging, SSH, Chrome
  skills/odoo-git-staging/              reglas git, commit, push, commit status
  skills/odoo-sh-remote/                build, logs y tests en Odoo.sh
  agents/odoo-verifier.md               revisor de evidencias (solo lectura)
  hooks/hooks.json + scripts/guard.js   política de seguridad
  scripts/                              config, ssh-check, run-state, report
  tests/                                node --test, sin dependencias
  docs/install-windows.md, docs/security.md
```

## Instalación

Requisitos y pasos detallados para Windows en [docs/install-windows.md](docs/install-windows.md). Resumen:

```powershell
claude plugin marketplace add hachecito/odoo-agent-plugins        # o la ruta local de este repo
claude plugin install odoo-browser-agent@odoo-agent-plugins
claude --chrome                                     # para usar Claude in Chrome
```

Desarrollo local sin instalar, desde la raíz del repositorio: `claude --plugin-dir .\plugins\odoo-browser-agent`.

## Uso

1. En el repo de módulos conectado a Odoo.sh, preparar una rama staging para el agente.
2. `/odoo-browser-agent:odoo-project-setup`: crea `.claude/odoo-agent.json` con la rama staging y las ramas de producción, y comprueba Chrome, GitHub y SSH.
3. `/odoo-browser-agent:odoo-task Corregir el cálculo de X en sale_custom y añadir test`.
4. El agente pide confirmación antes de cada push y entrega un informe con el resultado: **COMPLETADA**, **PARCIALMENTE VERIFICADA**, **FALLIDA** o **BLOQUEADA**.

### Configuración por repo (`.claude/odoo-agent.json`)

```json
{
  "odoo_sh_project": "mi-proyecto",
  "staging_branch": "staging-agente",
  "production_branches": ["main"],
  "odoo_version": "18.0",
  "ssh": { "enabled": true, "key": null },
  "allowed_domains": ["odoo.sh", "odoo.com", "github.com"]
}
```

Excluir los archivos del agente sin tocar el `.gitignore` del cliente, añadiéndolos a `.git/info/exclude`: `.claude/odoo-agent.json`, `.claude/odoo-agent-run.json`, `.claude/odoo-agent-notes.json`.

### Aprendizaje por proyecto (`.claude/odoo-agent-notes.json`)

Al terminar cada tarea, el agente guarda entre 0 y 5 notas con lo que comprobó y le servirá la próxima vez (comandos que funcionaron, rutas, host SSH, módulos con tests lentos, errores recurrentes). Al empezar la siguiente tarea, las lee.

- Solo se escriben con `scripts/notes.js`, que **rechaza** reglas, permisos, operaciones git de escritura y posibles secretos. Editar el archivo directamente pide confirmación.
- Son datos, no instrucciones: nunca cambian las reglas de seguridad.
- Ver o depurar: `node <plugin>\scripts\notes.js show` y `node <plugin>\scripts\notes.js remove <n>`.

## Acceso SSH a Odoo.sh

La clave SSH es **por usuario**, no por proyecto: se configura una vez.

1. Autorizar la IP en Odoo.sh y esperar a que se aplique.
2. Añadir la clave pública al perfil de Odoo.sh (avatar → *Profile*):
   - **Importarla desde GitHub** (lo más rápido si la clave ya está en la cuenta de GitHub), o
   - generarla (`ssh-keygen -t ed25519`) y pegar el contenido de `~/.ssh/id_ed25519.pub` en *Add a key manually*.
3. Ser colaborador del proyecto en Odoo.sh.
4. Probar con el comando SSH que muestra la rama en Odoo.sh:
   ```powershell
   node plugins\odoo-browser-agent\scripts\ssh-check.js <build_id>@<dominio>.dev.odoo.com
   ```

| Resultado | Causa probable |
|---|---|
| `Permission denied (publickey)` | La clave no está en el perfil de Odoo.sh o no se es colaborador |
| Timeout / connection refused | IP no autorizada o aún no aplicada |
| `Could not resolve hostname` | Host incorrecto (el build id cambia con cada build) |

Sin SSH, el agente usa la terminal del editor web (`https://<build>/odoo-sh/editor/lab`).

## Seguridad

Ver [docs/security.md](docs/security.md). En resumen: push solo a la rama staging y con confirmación; producción, force push y borrado de ramas bloqueados; la interfaz de Odoo.sh es de solo lectura para el agente.

## Tests

Pruebas de aceptación con un cliente real (rama staging sin uso): [docs/pruebas-aceptacion.md](docs/pruebas-aceptacion.md).

Tests unitarios:

```powershell
cd plugins\odoo-browser-agent   # desde la raíz del repositorio
npm test
```

## Estado

v0.1.0. Pendiente de validar en un proyecto Odoo.sh real:
- nombres exactos de las herramientas de Claude in Chrome;
- qué herramienta del MCP de GitHub devuelve los commit statuses;
- obtención automática del host SSH del último build;
- comando exacto para tests en el build (`skills/odoo-sh-remote/reference/tests.md`).
