# odoo-agent-plugins

Marketplace de plugins de Claude Code para desarrollo Odoo y Odoo.sh. Cada plugin vive en su propia carpeta dentro de `plugins/`.

## Plugins

| Plugin | Descripción |
|---|---|
| [odoo-browser-agent](plugins/odoo-browser-agent/README.md) | Tareas Odoo de principio a fin sobre una rama staging de Odoo.sh: código y tests, commit, push con confirmación, verificación de build, logs y tests (SSH o Claude in Chrome) e informe con evidencias. |

## Instalación

```powershell
claude plugin marketplace add hachecito/odoo-agent-plugins      # o la ruta local de este repositorio
claude plugin install <plugin>@odoo-agent-plugins
```

## Actualización

```powershell
claude plugin marketplace update odoo-agent-plugins
claude plugin update odoo-browser-agent@odoo-agent-plugins     # comprobar claude plugin list --> nueva versión
```

## Estructura

```
.claude-plugin/marketplace.json   catálogo de plugins de este repositorio
plugins/<plugin>/                 un plugin por carpeta (plugin.json, skills, agents, hooks, scripts, docs, tests)
```

## Añadir un plugin nuevo

1. Crear `plugins/<nombre-en-kebab-case>/.claude-plugin/plugin.json` con al menos `name`.
2. Añadir sus componentes (`skills/`, `agents/`, `hooks/hooks.json`, `scripts/`) y un `README.md`.
3. Registrar la entrada en `.claude-plugin/marketplace.json` con `"source": "./plugins/<nombre>"`.
4. Validar: `claude plugin validate .\plugins\<nombre>` y `claude plugin validate .`.
