# odoo-local-env

Local Odoo environments on Docker, for tests. Independent: the other plugins of this marketplace do not use it, and it only runs when you ask for it.

```
/odoo-local-env:local-env mount a local environment of this repo, Odoo 19, with the backup C:\backups\client.zip
```

## What it does

- **Database**: restores an Odoo.sh backup (`.zip` with `dump.sql` and `filestore/`), a `pg_dump` custom file (`.dump`) or a plain `.sql`, streamed without extracting it to disk; or creates an empty database. A restored database is always **neutralized** (`odoo neutralize`; SQL on 15).
- **Code**: the repo (modules at the root and in submodules, detected like Odoo.sh does) and Enterprise are mounted **read-only**; edit the code on your machine and run `update`.
- **Enterprise**: cloned once per version from `odoo/enterprise` with your own GitHub access, or an existing folder you register.
- **Python dependencies**: the `requirements.txt` files of the repo, its submodules and modules are installed in a project image on top of the official `odoo:<version>` image.
- **Data**: Postgres (with pgvector, needed by Odoo 19) and the filestore live in Docker volumes; Odoo listens on `127.0.0.1` only.
- **Lifetime**: an environment stays until you release it; `clean` frees disk by version.

## Requirements

- Docker running: Docker Desktop on Windows and macOS, Docker Engine on Linux. If it is stopped the agent asks you to start it.
- Node.js 18 or later and `git`.
- For Enterprise: access to `github.com/odoo/enterprise` with your account, or a local Enterprise folder.

## Commands

`node <plugin>/scripts/localenv.js <command>` (the skill runs them for you):

| Command | What it does |
|---|---|
| `doctor` | Checks Docker is running |
| `enterprise --version 19.0 [--path dir]` | Clones Enterprise for a version, or registers your own folder (never deleted) |
| `addons --repo dir` | Shows the addons folders found in a repo |
| `up --name n --repo dir --version 19.0 [--backup file] [--modules a,b]` | Creates and starts an environment |
| `list` / `status --name n` | Environments, state, port, kept or released, disk used |
| `start` / `stop --name n` | Starts or stops it (stop frees RAM, keeps the data) |
| `update` / `install --name n --modules a,b` | `-u` / `-i` and restart |
| `test --name n --modules a,b [--tags t]` | Runs the module tests |
| `logs --name n [--tail 500]` | Odoo log |
| `keep` / `release --name n` | Keeps the environment until released / lets `clean` delete it |
| `down --name n --yes` | Deletes the environment (containers, database, filestore) |
| `clean [--version 16.0] [--yes]` | Lists, then deletes, released environments and, by version, the image and the plugin's Enterprise clone |

Everything is stored in `~/.oap/local-env/` (`envs/<name>/` with the generated `compose.yaml` and `odoo.conf`, `enterprise/<version>/`). The generated files hold random passwords and are never written into your repo.

On Docker Desktop, deleting images and volumes does not shrink its disk image by itself; compacting it is a separate manual step.
