---
name: local-env
description: Mounts, manages and cleans local Odoo environments on Docker for tests - restores an Odoo.sh backup (.zip) or a dump, or creates an empty database, with the repo's modules and Enterprise; upgrades, installs and tests modules; keeps an environment until the user releases it; deletes environments, images and Enterprise clones to free disk. Use only when the user asks for a local environment ("monta un entorno local", "levanta odoo en local", "limpia los entornos").
---

# Local Odoo environment (Docker)

Language: instructions are in English; reply to the user in the language they use (Spanish: neutral, never vosotros forms).

Below `le` means `node "${CLAUDE_PLUGIN_ROOT}/scripts/localenv.js"`. Everything lives in `~/.oap/local-env/` (environments in `envs/<name>/`, Enterprise clones in `enterprise/<version>/`); data (Postgres, filestore) lives in Docker volumes, the code is mounted read-only.

## Rules

- **Docker**: run `le doctor` first. Exit code 2 means the engine is down: ask the user to start Docker Desktop (Windows/macOS) or the docker service (Linux) and wait. Never start it yourself and never manage WSL.
- **Never touch the user's working copy**: if the repo the user names is on another branch or has uncommitted changes, do not checkout there; clone the branch into `~/.oap/local-env/src/<name>` with `--recurse-submodules` instead (ask first if unsure).
- **Production data**: a restored backup is always neutralized (`odoo neutralize`, or SQL on 15). Only skip it (`--no-neutralize`) if the user asks explicitly. Never connect the environment to a real mail server or payment provider.
- **Deleting** (`down`, `clean --yes`) only after the user confirms; show what will be deleted first (`clean` without `--yes` is a dry run). `clean` never deletes Enterprise folders registered with `--path` (the user's own).
- Long steps (image build, restoring a multi-GB dump) can exceed 10 minutes: run `le up` in the background and report progress from its output.

## Mount an environment

1. **Ask** (AskUserQuestion; never infer): the repo (path or GitHub branch), the Odoo version, and the database: a backup path (Odoo.sh `.zip` with `dump.sql` + `filestore/`, a `.dump` or a `.sql`) or none (empty database). Propose a name like `<project>-<task>`.
2. **Code**: the repo path must have its submodules checked out (`git submodule update --init`). Check what will be loaded: `le addons --repo <dir>`.
3. **Enterprise** (skip for Community with `--enterprise none`):
   - `le enterprise --version <v>` clones `odoo/enterprise` once per version with the user's own GitHub access; if there is no access it says so.
   - If the user already has an Enterprise folder for that version: `le enterprise --version <v> --path <dir>`.
4. **Up**: `le up --name <n> --repo <dir> --version <v> [--backup <file>] [--modules a,b]`.
   - With a backup: restores dump and filestore, neutralizes, then (if `--modules`) upgrades them.
   - Without a backup: creates an empty database with `base` plus `--modules`.
   - The repo's `requirements.txt` files (root, submodules, modules) are installed in a project image built on the official `odoo:<v>` image.
   - It prints the URL (`http://localhost:<port>`). The admin user's password is the one of the restored database; for an empty database it is `admin`.
5. Tell the user the URL, the database name and that the environment is **kept** until they release it.

## Work with it

- `le list`: environments, state, port, kept or released, disk used.
- `le update --name <n> --modules a,b` (`-u`) / `le install --name <n> --modules a,b` (`-i`): stops the server, runs the update, restarts.
- `le test --name <n> --modules a,b [--tags ...]`: runs the module tests (default tags `/module`) and returns the exit code; quote the failing tests from the output.
- `le logs --name <n> [--tail 500]`, `le stop|start --name <n>` (stop frees RAM and keeps everything).

## Clean up

- `le keep|release --name <n>`: kept environments survive `clean`; release one when the user is done with the task.
- `le down --name <n>` then, after the user's OK, `--yes`: deletes that environment (containers, database, filestore, project image).
- `le clean [--version 16.0]` lists released environments and, with `--version`, the `odoo:<v>` image and the plugin's Enterprise clone for that version; repeat with `--yes` after the user confirms. Kept environments block deleting the image and Enterprise of their version.
- Docker Desktop does not shrink its disk image by itself after deleting; tell the user compacting it is a separate manual step.
