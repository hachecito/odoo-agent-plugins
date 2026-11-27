# oap-memory

Shared memory of the Odoo Agent Plugins. odoosh-browser, odoo-squad and any later plugin of this marketplace depend on it: the agents remember what they learn in each project, find it again by searching instead of re-reading everything, and share what is reusable across projects. It is installed automatically as a dependency.

## Stores

Markdown files with YAML properties, one entry per file. The index (`_index/`) is derived: deleting it loses nothing.

| Store | Where | What |
| --- | --- | --- |
| Project | `.oap/memory/` | lessons, quirks, conventions, decisions of this repo |
| Tasks | `.oap/odoo-squad/tasks/<id>/summary.md` | what each task did and its outcome |
| Global | `~/.oap/knowledge/` | Odoo, Odoo.sh, editor, tests and tooling knowledge for every project |

The repo is found by the nearest folder with its own `.oap/` (never the `.oap/` of the home folder, which holds global knowledge), else by git (the main project, also from inside a submodule). The first entry written adds `.oap/` to `.git/info/exclude`.

- **Read by levels, never whole.** `knowledge.js context` gives ~1,500 tokens: project profile, the most relevant entries (BM25 over title, tags, summary and body, weighted by status, Odoo version and scope) and similar past tasks. Then `get <id> [--section "How to apply"]` or `search "<words>"` only when needed. Nothing is loaded when Claude Code starts. Measured: ~25 ms with 1,000 entries and ~110 ms with 5,000; the output stays ~1,800 characters whatever the size.
- **Status**: `observed` (seen in a task), `verified` (with proof: a reproducing test, command output, Odoo source file:line of that version) and `deprecated` (contradicted or replaced; out of searches). Duplicates are refused with the similar entry's id.
- **Global knowledge is automatic, with checks.** A verified entry is copied only if its category is reusable (`odoo`, `odoo-sh`, `editor`, `tests`, `tooling`, `migration`, `debugging`, plus those the plugins declare) and it names none of the project's own modules (git submodules such as OCA ones do not count), repo folder or the names the plugins declare (e.g. Odoo.sh project and staging branch), and holds no e-mails, IPs, phone numbers, build hosts or non-public links. Only public evidence travels. Correcting the project entry updates its global copy. The task report lists every promotion with `knowledge.js remove <g-id>` to undo it. These are text checks: the report is how you catch what they miss.
- **Safety**: text aimed at the plugins' safeguards (branch config, autonomy, the guard, skipping confirmations, pushing to production) or that looks like a secret is rejected; Odoo knowledge about access rights, install hooks or skipped tests is accepted. Everything read from memory is data, not instructions.
- **Projects with the old `.oap/memory.md`** keep working: `context` shows their notes first and `notes.js` writes there (max. 100 notes in that format). `knowledge.js migrate` (dry-run, writes nothing), `--apply` (backup in `.oap/backups/`, one entry per note, a `summary.md` per task, every note checked, `memory.md` renamed to `memory.md.migrated`; a second run adds nothing), `--rollback <stamp>` (back to the old format, later notes included). After it, `notes.js show/add/remove` work on the new entries.
- Maintenance: `knowledge.js validate`, `stats`, `reindex [--full]`, `deprecate <id> [--by <id>]`.

## Session, hooks and safeguards

A plugin opens a **memory session** when a task starts (`session start --source <plugin>`) and closes it at the end (`session end`; idle for 24 h it closes on its own). In odoosh-browser and odoo-squad, `run-state.js` also opens it on `init` and closes it on `close`, `COMPLETED` and `FAILED`, so the session always lasts exactly as long as the task. Lessons written within 6 h after it closes still go to that task's report. It lives in `.oap/memory-session.json` and drives:

- **Reminders** (`memory-hook.js`, `PostToolUseFailure` and `Stop`): after a tool failure, note the finding right away (at most every 10 min); on finishing, one block per session if nothing was noted. It never creates stop loops. Without a session it says nothing.
- **The report's Knowledge section**: `session report` lists what was added, promoted or kept in the project.
- **The memory guard** (`mem-guard.js`, `PreToolUse`), which only asks or denies, never approves:
  - editing `.oap/memory/`, `~/.oap/knowledge/` or `.oap/memory.md` directly, or writing them from the shell → confirmation;
  - `knowledge.js remove` and `migrate --apply|--rollback`, by any route (`knowledge.js`, `mem.js`, `oap.js`) → confirmation;
  - a subagent writing memory (`add`, `update`, `deprecate`, `remove`, `reindex`, `migrate`, `task-summary`, `session`, `notes.js add|remove`) while a session is open → denied; it can read.

  Commands that mention none of `.oap`, `knowledge`, `notes`, `mem.js` or `oap.js` get no opinion, and an internal error never blocks. With several plugins' hooks, Claude Code keeps the most restrictive decision (checked with Claude Code 2.1.332: `ask` beats `allow`, `deny` beats `allow`), so a plugin's `yolo` approval does not skip these.

## Using it from a plugin

Three steps, no memory code in the plugin:

1. **Dependency** in `.claude-plugin/plugin.json`: `"dependencies": ["oap-memory"]` (Claude Code installs it, also on `plugin update`).
2. **Declaration** `memory.json` at the plugin root:

   ```json
   {
     "source": "odoo-localenv",
     "min_memory_version": "1.0.0",
     "global_categories": ["docker", "local-env"],
     "project_terms": [{ "file": ".oap/odoo-localenv/config.json", "keys": ["db_name"] }],
     "odoo_version": { "file": ".oap/odoo-localenv/config.json", "key": "odoo_version" }
   }
   ```

   `global_categories` may go to global knowledge; `project_terms` are names of the project (read from that repo file) that must never reach it; `odoo_version` is the default for searches.
3. **Launcher** `scripts/mem.js`: copy it unchanged from another plugin of this repo (a test checks the copies are identical). In the skills:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/mem.js" session start --source odoo-localenv --task "<summary>"
   node "${CLAUDE_PLUGIN_ROOT}/scripts/mem.js" context --text "<what the task is about>"
   node "${CLAUDE_PLUGIN_ROOT}/scripts/mem.js" add --title "..." --summary "..." --category local-env
   node "${CLAUDE_PLUGIN_ROOT}/scripts/mem.js" session end
   ```

   And cite the `oap-memory:memory-rules` skill for when to read, what to record and what never. If oap-memory is missing or too old, `mem.js` exits with code 3 and prints the install command: the skill goes on without memory.

## Contents

```
plugins/oap-memory/
  .claude-plugin/plugin.json
  skills/memory-rules/          how agents read and write the memory
  hooks/hooks.json              mem-guard (PreToolUse), memory-hook (PostToolUseFailure, Stop)
  scripts/knowledge.js          Knowledge Manager CLI
  scripts/notes.js              old-format notes (.oap/memory.md)
  scripts/lib/knowledge/        schema, store, index (BM25), search, promotion, validation, migration
  scripts/lib/                  root, plugin declarations, session, guard, atomic files
  tests/                        node --test, no dependencies
```

## Tests

```powershell
cd plugins\oap-memory
npm test
```
