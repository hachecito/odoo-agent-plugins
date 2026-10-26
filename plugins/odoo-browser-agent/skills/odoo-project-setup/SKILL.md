---
name: odoo-project-setup
description: Prepara un repositorio de módulos Odoo para el agente autónomo. Crea o valida .claude/odoo-agent.json, pide al usuario la rama staging de Odoo.sh, declara las ramas de producción y comprueba Claude in Chrome, SSH a Odoo.sh y acceso a GitHub. Usar antes de la primera tarea en un repo, cuando falte la configuración o cuando el usuario quiera cambiar la rama staging.
---

# Configuración del proyecto para odoo-browser-agent

Objetivo: dejar `.claude/odoo-agent.json` válido en la raíz del repo de módulos y saber qué canales (Chrome, SSH, GitHub) están disponibles.

Las protecciones del plugin (hook `guard.js`) **solo se activan en repos con este archivo**. Sin él no hay salvaguardas: no empezar ninguna tarea.

## Pasos

1. **Ubicar el repo**: `git rev-parse --show-toplevel`. Debe ser el repo conectado a Odoo.sh (`git remote -v` apunta a GitHub).
2. **Ver si ya existe config**:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.js" show`
3. **Pedir datos al usuario** (con AskUserQuestion; nunca deducirlos):
   - **Rama staging** de Odoo.sh que el usuario ha dejado preparada para el agente. Es obligatoria.
   - **Ramas de producción** (la rama de la etapa Production en Odoo.sh). Por defecto `main,master,production`.
   - Nombre del proyecto en Odoo.sh y versión de Odoo (se puede proponer la versión leída de `__manifest__.py` o con la skill `detect-env`).
4. **Crear o actualizar**:
   - Nuevo: `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.js" init --staging <rama> --production main --project <proyecto> --version 18.0`
   - Cambiar staging: `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.js" set-staging <rama>`
   - Validar: `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.js" validate` (debe salir "Configuración válida").
5. **Archivos del agente fuera del repo del cliente**: proponer añadirlos a `.git/info/exclude` (exclusión local, no modifica el `.gitignore` del cliente) salvo que el usuario quiera versionarlos:
   ```
   .claude/odoo-agent.json
   .claude/odoo-agent-run.json
   .claude/odoo-agent-notes.json
   ```
6. **Comprobar canales** y anotar el resultado al usuario:
   - **Claude in Chrome**: comprobar que hay herramientas `mcp__claude-in-chrome__*` disponibles. Si no, indicar al usuario que arranque con `claude --chrome` o ejecute `/chrome`. Un plugin no puede activarlo.
   - **GitHub**: confirmar que el MCP `github` responde (por ejemplo, leer el último commit de la rama staging).
   - **SSH a Odoo.sh** (opcional): pedir al usuario el comando SSH de un build de la rama staging (Odoo.sh → rama → pestaña SSH; formato `<build_id>@<dominio>.dev.odoo.com`) y ejecutar:
     `node "${CLAUDE_PLUGIN_ROOT}/scripts/ssh-check.js" <build_id>@<dominio>`
     - `OK` → `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.js" set-ssh --enabled true` y guardar el host como nota para no volver a pedirlo: `node "${CLAUDE_PLUGIN_ROOT}/scripts/notes.js" add --section odoo-sh --text "Host SSH del build staging: <build_id>@<dominio>" --source "setup"`. Si en otra tarea el host deja de responder (el build pudo cambiar), pedir el nuevo al usuario y sustituir la nota.
     - `EXEC_INTERMITTENT` → la clave funciona; reintentar más tarde o usar el terminal del editor.
     - `PUBLICKEY` → la clave no está en el perfil de Odoo.sh. Guiar: Odoo.sh → avatar → *Profile* → importar claves desde GitHub, o *Add a key manually* pegando **solo** el contenido de `~/.ssh/id_ed25519.pub`. Ser colaborador del proyecto.
     - `NETWORK` → la IP no está autorizada o aún no se aplicó; esperar y reintentar.
     - Si SSH no está disponible, el flujo usará la terminal del editor web de Odoo.sh.

## Reglas

- Nunca leer, mostrar ni copiar claves privadas, cookies o tokens.
- Añadir una clave al perfil de Odoo.sh modifica la cuenta del usuario: solo con su confirmación explícita y preferiblemente que lo haga el propio usuario.
- La rama staging nunca puede coincidir con una rama de producción (el script lo rechaza).
