---
name: local-env
description: Mounts local Odoo test environments on Docker from an Odoo.sh backup, an Odoo.sh build or an empty database; upgrades and tests modules; resets and cleans up. Only when the user asks.
metadata:
  author: hachecito
  tags: [odoo, docker, local-environment, testing]
---

# Local Odoo environment (Docker)

Language: instructions are in English; reply to the user in the language they use (Spanish: neutral, never vosotros forms).

Below `le` means `node "${CLAUDE_PLUGIN_ROOT}/scripts/localenv.js"`. Everything lives in `~/.oap/local-env/` (environments in `envs/<name>/`, Enterprise clones in `enterprise/<version>/`); data (Postgres, filestore) lives in Docker volumes, the code is mounted read-only.

## Purpose

Give the user a disposable local copy of an Odoo project (code from the repo, data from a backup or a build) to try fixes and run tests without waiting for Odoo.sh builds. Triggers: "monta un entorno local", "levanta odoo en local", "limpia los entornos".

## Requirements

- Docker running (Docker Desktop on Windows/macOS, Docker Engine on Linux), Node.js 18+ and git.
- Enterprise: access to github.com/odoo/enterprise with the user's account, or a local Enterprise folder.
- Optional, for `--from-odoosh`: the user's SSH key registered in Odoo.sh.

## Rules

- **Docker**: run `le doctor` first. Exit code 2 means the engine is down: ask the user to start Docker Desktop (Windows/macOS) or the docker service (Linux) and wait. Never start it yourself and never manage WSL.
- **Never touch the user's working copy**: if the repo the user names is on another branch or has uncommitted changes, do not checkout there; clone the branch into `~/.oap/local-env/src/<name>` with `--recurse-submodules` instead (ask first if unsure).
- **Production data**: a restored backup is always neutralized (`odoo neutralize`, or SQL on 15). Only skip it (`--no-neutralize`) if the user asks explicitly. Never connect the environment to a real mail server or payment provider.
- **Deleting** (`down`, `clean --yes`) only after the user confirms; show what will be deleted first (`clean` without `--yes` is a dry run). `clean` never deletes Enterprise folders registered with `--path` (the user's own).
- Long steps (image build, restoring a multi-GB dump) can exceed 10 minutes: run `le up` in the background and report progress from its output.

## Mount an environment

1. **Ask** (AskUserQuestion; never infer): the repo (path or GitHub branch), the Odoo version, and the database: a backup path (an Odoo.sh zip with the SQL dump and the filestore folder, a pg_dump custom file or a plain SQL file), an Odoo.sh build to copy over SSH, or none (empty database). Propose a name like `<project>-<task>`.
2. **Code**: the repo path must have its submodules checked out (`git submodule update --init`). Check what will be loaded: `le addons --repo <dir>`.
3. **Enterprise** (skip for Community with `--enterprise none`):
   - `le enterprise --version <v>` clones `odoo/enterprise` once per version with the user's own GitHub access; if there is no access it says so.
   - If the user already has an Enterprise folder for that version: `le enterprise --version <v> --path <dir>`.
4. **Up**: `le up --name <n> --repo <dir> --version <v> [--backup <file>] [--modules a,b]`.
   - With a backup: restores dump and filestore, neutralizes, then (if `--modules`) upgrades them.
   - With `--from-odoosh <build id>@<build host>` instead of `--backup`: downloads the database (`pg_dump`) and the filestore of that build over SSH into `~/.oap/local-env/downloads/<name>/`, then restores like a backup. Only for **staging or development builds, never production**, and only with the user's OK; the user copies the SSH target from the build's SSH/Shell tab in Odoo.sh and their SSH key must be registered there. The build must run the same Odoo version (it refuses otherwise; for a migration use the migrated backup). On the build only `psql` queries, `pg_dump` and `tar` run. The filestore path (`~/data/filestore/<db>`) has not been verified on a real build yet: if the tar step fails, tell the user.
   - After a restore it takes a **snapshot** (copy of database and filestore) so `reset` can go back in seconds; `--no-snapshot` skips it when disk is short.
   - Without a backup: creates an empty database with `base` plus `--modules`.
   - The Python requirements files of the repo (root, submodules, modules) and the manifest dependencies are installed in a project image built on the official `odoo:<v>` image.
   - It prints the URL (`http://localhost:<port>`). The admin user's password is the one of the restored database; for an empty database it is `admin`.
5. Tell the user the URL, the database name and that the environment is **kept** until they release it.

## Work with it

- `le list`: environments, state, port, kept or released, disk used.
- Code changes in the repo folder are seen live (read-only mount): Python changes need `le restart --name <n>`; views, data and new fields need `le update`.
- `le rebuild --name <n> [--repo <dir>] [--pip a,b]`: after new submodules or requirements, to point the environment to another folder of the repo, or to add pip packages a module imports without declaring them (an "No module named X" in the log). The database is kept.
- If Odoo answers HTTP 500, read the ERROR/CRITICAL lines of the log and tell the user: they are usually project errors (a module or a view of the database), not environment errors.
- `le update --name <n> --modules a,b` (`-u`) / `le install --name <n> --modules a,b` (`-i`): stops the server, runs the update, restarts.
- `le test --name <n> --modules a,b [--tags ...]`: runs the module tests (default tags `/module`) and returns the exit code; quote the failing tests from the output.
- `le reset --name <n>`: back to the snapshot (discards everything done since). `le snapshot --name <n>`: make the current state the new reset point (asks nothing, replaces the previous one: tell the user).
- **Migrated databases** often fail to render (HTTP 500) because of views or website editor customizations (`ir_asset` with `/_custom/` paths) saved in the database that no longer fit the new version. List the failing ones from the log and, with the user's OK, deactivate them in the local copy only (`UPDATE ir_ui_view SET active = false WHERE id = ...`, then `le restart`). Report what was deactivated: they are migration issues to fix in the project.
- `le logs --name <n> [--tail 500]`, `le stop|start --name <n>` (stop frees RAM and keeps everything).

## Clean up

- `le keep|release --name <n>`: kept environments survive `clean`; release one when the user is done with the task.
- `le down --name <n>` then, after the user's OK, `--yes`: deletes that environment (containers, database, filestore, project image).
- `le clean [--version 16.0]` lists released environments and, with `--version`, the `odoo:<v>` image and the plugin's Enterprise clone for that version; repeat with `--yes` after the user confirms. Kept environments block deleting the image and Enterprise of their version.
- Docker Desktop does not shrink its disk image by itself after deleting; tell the user compacting it is a separate manual step.

## Examples

- "Monta un entorno local de este repo en 19 con C:\backups\client.zip": `le up --name client-task --repo . --version 19.0 --backup C:\backups\client.zip`.
- "Prueba mi cambio en sale_custom": `le update --name client-task --modules sale_custom`, then `le test --name client-task --modules sale_custom`.
- "Vuelve a los datos originales": `le reset --name client-task`.
- "Ya no trabajo con 16": `le clean --version 16.0`, show the list, then `--yes` after the user's OK.

## Limitations

- One Odoo version per environment; the backup or build must be of that version.
- The image ships a recent Community build of the version; it can differ from what Odoo.sh runs.
- Libraries a module imports without declaring them must be added with `--pip`.
- No outbound network isolation: neutralizing is what keeps mails and payments off.
- `--from-odoosh` has not been tried on a real build yet.

## Troubleshooting

| Error | Cause | Solution |
|---|---|---|
| Exit 2 "Docker is not running" | Docker Desktop or the service is stopped | Ask the user to start it |
| `extension "vector" is not available` | Odoo 19 dump on plain Postgres | Recreate the environment (the plugin uses pgvector images) |
| `No module named X` in the log | Undeclared Python dependency | `le rebuild --name <n> --pip X` |
| HTTP 500, "no puede ser localizado en la vista padre" | Database view from an older version | Deactivate it in the local copy with the user's OK (see Work with it) |
| "not found in bundle" | Website editor customization (`/_custom/` asset) | Deactivate those `ir_asset` rows in the local copy with the user's OK |
| Module "not installable, skipped" | Not ported to this version | Project issue: report it |
