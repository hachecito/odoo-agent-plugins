---
name: odoo-project-setup
description: Prepares an Odoo modules repo for the agent - creates or validates .oap/odoosh-browser/config.json, asks for the Odoo.sh staging branch, declares production branches and checks Claude in Chrome, SSH and GitHub. Use before the first task in a repo, when the config is missing or the user wants to change the staging branch.
---

# Project setup for odoosh-browser

Language: instructions are in English; reply to the user in the language they use. Texts for a client use the client's language (Spanish: neutral, never vosotros forms).

Goal: a valid `.oap/odoosh-browser/config.json` at the root of the modules repo, and knowing which channels (Chrome, SSH, GitHub) are available.

The plugin's protections (`guard.js` hook) **only apply in repos with this file**. Without it there are no safeguards: do not start any task.

## Steps

1. **Locate the repo**: `git rev-parse --show-toplevel`. It must be the repo connected to Odoo.sh (`git remote -v` points to GitHub).
2. **Check for an existing config**:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.js" show`
3. **Ask the user** (with AskUserQuestion; never infer):
   - The Odoo.sh **staging branch** the user has prepared for the agent. Mandatory.
   - **Production branches** (the branch of the Production stage on Odoo.sh). Default `main,master,production`.
   - Odoo.sh project name and Odoo version (the version read from `__manifest__.py` or with the `detect-env` skill can be proposed).
4. **Create or update**:
   - New: `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.js" init --staging <branch> --production main --project <project> --version 18.0`
   - Change staging: `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.js" set-staging <branch>`
   - Validate: `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.js" validate` (must report a valid configuration).
5. **`.oap/` folder kept out of the client's repo**: `config.js init` adds `.oap/` to `.git/info/exclude` (local exclusion; the client's `.gitignore` is not modified). If the repo has files in `.claude/odoosh-browser*.json` or `.claude/odoo-agent*.json`, propose `config.js migrate` (asks for confirmation): it moves them to `.oap/` and, through oap-memory, converts the old notes into `.oap/memory.md`.
6. **Old project memory** (plugin `oap-memory`; below `mem.js` = `node "${CLAUDE_PLUGIN_ROOT}/scripts/mem.js"`): if `config.js validate` warns that the memory is in the old format (`.oap/memory.md` or task folders without `summary.md`), migrate it before the first task:
   - Run `mem.js migrate` (dry-run: writes nothing) and show the user the totals and any skipped note with its reason.
   - With the user's OK, `mem.js migrate --apply` (the memory guard asks for confirmation). It backs up to `.oap/backups/`, verifies every note, renames `memory.md` to `memory.md.migrated` and writes a report in `.oap/memory/migrations/`. Running it twice adds nothing.
   - If something looks wrong: `mem.js migrate --rollback <stamp>` (stamp from `migrate --history`).
7. **Check channels** and report the result to the user:
   - **Claude in Chrome**: check that `mcp__claude-in-chrome__*` tools are available. If not, tell the user to start with `claude --chrome` or run `/chrome`. A plugin cannot enable it. Do not replace it with another browser MCP (`chrome-devtools`, Playwright…).
   - **GitHub**: confirm the `github` MCP responds (e.g. read the last commit of the staging branch).
   - **Stages on Odoo.sh** (if Claude in Chrome is available): open the project on Odoo.sh and check in the left panel that the staging branch is under *Staging* and the branches under *Production* match `production_branches` (see `skills/odoo-sh-remote/reference/odoo-sh-ui.md`). If they do not match, warn and fix the config with the user.
   - **SSH to Odoo.sh** (optional, off by default): the main channel is the web editor, which depends on neither IP nor keys. In real projects SSH has failed with timeouts (authorised IP that changes) and rejected keys, and each failure wastes minutes. Set it up **only if the user asks**. In that case: get the SSH command of the staging branch build, by reading it with Claude in Chrome on Odoo.sh (branch → **SSH** button, text field with `ssh <build_id>@<domain>.dev.odoo.com`) or asking the user, and run:
     `node "${CLAUDE_PLUGIN_ROOT}/scripts/ssh-check.js" <build_id>@<domain>`
     - `OK` → `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.js" set-ssh --enabled true` and save the host as a note so it is not asked again: `mem.js notes add --tag odoo-sh --text "SSH host of the staging build: <build_id>@<domain>" --source "setup"`. The host is stable per branch (observed in two projects): if it stops answering in a later task, the cause is usually the IP or the key, not a new host; continue through the editor and tell the user.
     - `EXEC_INTERMITTENT` → the key works; retry later or use the editor terminal.
     - `PUBLICKEY` → the key is not in the Odoo.sh profile. Guide: Odoo.sh → avatar → *Profile* → import keys from GitHub, or *Add a key manually* pasting **only** the content of the **public** key (the `.pub` file of their SSH key; never the private one). They must be a project collaborator.
     - `NETWORK` → the IP is not authorised or not applied yet; wait and retry.
     - If it is not enabled or fails, the flow uses the Odoo.sh web editor terminal (output read through the editor API).

## Rules

- Never read, show or copy private keys, cookies or tokens.
- Adding a key to the Odoo.sh profile changes the user's account: only with their explicit confirmation, preferably done by the user.
- The staging branch can never be a production branch (the script rejects it).
