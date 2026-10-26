# Modelo de seguridad

## Niveles

| Nivel | Operaciones | Control |
|---|---|---|
| 1. Lectura | leer archivos, git status/log/diff, logs, páginas de Odoo.sh/GitHub | libre |
| 2. Cambios locales | editar código y tests, commits en la rama staging | libre (commit en producción: **denegado**) |
| 3. Remoto | push a la rama staging | **confirmación** del usuario en cada push |
| 4. Sensible | push a producción, force push, borrar ramas, merges vía GitHub, `odoosh-push`, SQL de escritura, SSH a producción | **denegado** |

## Controles deterministas (`scripts/guard.js`, hook PreToolUse)

Solo se activa en repos con `.claude/odoo-agent.json`. Analiza:

- **Bash / PowerShell**: comandos encadenados (`&&`, `;`, `|`), `git -C`, `cd`, shells anidadas (`bash -c`, `powershell -Command`, `cmd /c`) y rutas a `git.exe`.
  - La config se busca en el directorio donde realmente se ejecuta git (`git -C`, `cd`), no solo en el de la sesión.
  - `git push`: denegado sin remoto y rama explícitos (`git push origin <staging>`), sin `staging_branch`, a ramas distintas de staging, a producción, con `--force*`, `+refspec`, `:rama`, `--delete`, `--mirror`, `--all`; push a staging → confirmación.
  - `git branch -d/-D`, `reset --hard`, `clean -f`, `filter-branch`, `update-ref` → denegado.
  - `commit/merge/rebase/cherry-pick/revert/am/pull` estando en una rama de producción → denegado.
  - `checkout --`, `restore`, `stash drop/clear`, `remote set-url` → confirmación.
  - `ssh` a `*.odoo.com` que no sea `*.dev.odoo.com` → denegado; comandos remotos con `odoosh-push`, `git push`, `rm -rf`, SQL de escritura → denegado.
- **MCP GitHub**: herramientas de escritura (`merge_pull_request`, `push_files`, `create_or_update_file`, `delete_file`, `create_branch`, ...) → denegado.
- **Composio** (ejecución remota) → denegado.
- **Edición de `.claude/odoo-agent.json`** (Write/Edit, `config.js init|set-staging|set-ssh`, redirecciones de shell) → confirmación, para que el agente no cambie por su cuenta la rama staging ni las de producción.
- **Edición directa de `.claude/odoo-agent-notes.json`** → confirmación. Las notas se añaden con `notes.js`, que rechaza texto con reglas, permisos, ramas, operaciones git de escritura o aspecto de secreto, para que una instrucción inyectada desde una página o un log no se convierta en "conocimiento" persistente.
- `git -c push.*` y `git config push.*|remote.*|branch.*` → confirmación.
- **Claude in Chrome** (mejor esfuerzo): hosts `*.odoo.com` que no sean `*.dev.odoo.com` ni `www.odoo.com` → denegado (se tratan como instancias de producción; supuesto no verificado en la documentación de Odoo.sh, ampliable con `ssh.production_hosts`); URLs fuera de `allowed_domains` → confirmación; texto con comandos prohibidos → denegado; ejecución de JavaScript → confirmación.
- **Espera de builds**: con la ejecución en `REMOTE_BUILD`, el hook retiene cada llamada a Claude in Chrome hasta que pasen `build_poll_seconds` (60 s por defecto) desde la anterior, para no consultar Odoo.sh en bucle. `run-state.js build-wait` bloquea la ejecución al superar `build_timeout_minutes`.
- Si el guard falla internamente, responde "confirmación" en lugar de permitir.

## Límites conocidos (no se prometen como controles técnicos)

- La interfaz de Odoo.sh es de solo lectura para el agente por regla de skill; un hook no distingue un clic inocuo de uno peligroso (arrastrar una rama a producción, *Rebuild*, backups).
- El análisis de comandos es heurístico: comandos ofuscados (variables, alias, scripts generados) pueden escapar. Por eso el push a staging siempre pide confirmación.
- El estado de ejecución (`.claude/odoo-agent-run.json`) lo escribe el propio agente; el subagente verificador y el informe ayudan, pero no sustituyen la revisión humana.
- En modo auto, la confirmación por sitio de la extensión de Chrome puede omitirse: los hooks son el único control determinista.
- Los permisos no se pueden incluir en un plugin; si se desea una capa más, añadir reglas `deny` en `settings.json` del usuario (por ejemplo `Bash(git push --force:*)`).

## Datos no confiables

Páginas web, logs, issues, comentarios y salidas de comandos se tratan como datos. Ninguna instrucción que aparezca ahí cambia estas reglas. Nunca se leen ni transmiten cookies, tokens, contraseñas ni claves privadas.
