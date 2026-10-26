# Instalación en Windows

## Requisitos

| Requisito | Comprobación |
|---|---|
| Claude Code (sesión con `/login`, plan Pro/Max/Team/Enterprise para Claude in Chrome) | `claude --version` |
| Node.js 18+ (hooks y scripts) | `node -v` |
| Git | `git --version` |
| OpenSSH (incluido en Windows 10/11) | `ssh -V` |
| Google Chrome o Edge con la extensión **Claude in Chrome** 1.0.36+ | Chrome Web Store |
| MCP `github` configurado en Claude Code, o GitHub CLI (`gh`) | `/mcp` o `gh auth status` |
| context7 (documentación de Odoo) | `/mcp` |

## 1. Instalar el plugin

Desde el repositorio publicado en GitHub:

```powershell
claude plugin marketplace add hachecito/odoo-agent-plugins
claude plugin install odoo-browser-agent@odoo-agent-plugins
```

Desde una copia local:

```powershell
claude plugin marketplace add C:\ruta\odoo-agent-plugins
claude plugin install odoo-browser-agent@odoo-agent-plugins
```

Comprobar: `claude plugin validate C:\ruta\odoo-agent-plugins\plugins\odoo-browser-agent`.

## 2. Claude in Chrome

1. Instalar la extensión Claude in Chrome e iniciar sesión con la misma cuenta/organización que Claude Code.
2. Arrancar Claude Code con `claude --chrome` (o ejecutar `/chrome` dentro de la sesión; ahí se puede marcar *Enabled by default*).
3. Iniciar sesión en GitHub y Odoo.sh en ese Chrome. El agente reutiliza la sesión; si caduca o pide 2FA, se detiene y lo indica.
4. Ver las herramientas disponibles: `/mcp` → `claude-in-chrome` → *View tools*.

No se modifica la configuración del MCP `chrome-devtools` existente.

## 3. SSH a Odoo.sh

Ver la sección "Acceso SSH a Odoo.sh" del [README](../README.md#acceso-ssh-a-odoosh).

## 4. Commit status de Odoo.sh en GitHub

Para leer el resultado de los builds sin navegador, el proyecto de Odoo.sh debe tener configurado en *Settings* un token de GitHub con permiso de escritura de *commit statuses*. Sin él, el agente consulta el build en la web de Odoo.sh.

## 5. Preparar cada repo de módulos

Dentro de Claude Code, en el repo: `/odoo-browser-agent:odoo-project-setup`.

## Problemas frecuentes

| Síntoma | Solución |
|---|---|
| El hook no se ejecuta | Comprobar `node` en el PATH; `/hooks` debe listar el hook del plugin |
| No aparecen herramientas `claude-in-chrome` | Arrancar con `claude --chrome`; en `/chrome` usar *Reconnect* |
| `Permission denied (publickey)` | Añadir la clave al perfil de Odoo.sh (importar desde GitHub o pegar el `.pub`) |
| El push siempre se deniega | `node <plugin>\scripts\config.js show`: revisar `staging_branch` y la rama actual |
