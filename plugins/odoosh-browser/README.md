# odoosh-browser

Claude Code plugin that completes Odoo tasks end to end on an **Odoo.sh staging branch**: code and tests, commit, confirmed push, build verification, logs and tests on the build, and a final report with evidence.

It ships no browser extension or MCP of its own. It combines:

| Need | Tool |
|---|---|
| Code, commits, push | local git |
| Build status | branch page on Odoo.sh (*HISTORY*) with Claude in Chrome, or SSH to the build. Optional: GitHub commit status with `gh` (see note) |
| Logs, `odoo-update`, tests on the build | Odoo.sh web editor terminal, or SSH |
| Logged-in Odoo.sh pages | [Claude in Chrome](https://code.claude.com/docs/en/chrome) |
| Odoo questions | context7 (recommended, optional) + Odoo source code |
| Safeguards | deterministic `PreToolUse` hook (`scripts/guard.js`) |

context7 is not a dependency: without it the skills go straight to the Odoo source of the project's version. To add it: `claude plugin install context7@claude-plugins-official`.

## Contents

```
plugins/odoosh-browser/
  .claude-plugin/plugin.json
  skills/odoo-task/                     end-to-end orchestrator
  skills/odoo-project-setup/            per-repo config, staging branch, SSH, Chrome
  skills/odoo-git-staging/              git rules, commit, push, PRs
  skills/odoo-sh-remote/                build, logs and tests on Odoo.sh; test patch before the push
  agents/odoo-verifier.md               evidence reviewer (read-only)
  hooks/hooks.json + scripts/guard.js   security policy
  scripts/                              config, ssh-check, run-state, report, hotpatch, diag
  tests/                                node --test, no dependencies
  docs/install-windows.md, docs/security.md
```

## Installation

Detailed requirements and steps for Windows in [docs/install-windows.md](docs/install-windows.md). Summary:

```powershell
claude plugin marketplace add hachecito/odoo-agent-plugins        # or the local path of this repo
claude plugin install odoosh-browser@odoo-agent-plugins
claude --chrome                                     # to use Claude in Chrome
```

Local development without installing, from the repository root: `claude --plugin-dir .\plugins\odoosh-browser`.

## Usage

1. In the modules repo connected to Odoo.sh, prepare a staging branch for the agent.
2. `/odoosh-browser:odoo-project-setup`: creates `.oap/odoosh-browser/config.json` with the staging branch and the production branches, and checks Chrome, GitHub and SSH.
3. `/odoosh-browser:odoo-task Fix the X computation in sale_custom and add a test`.
4. The agent asks for confirmation before each push and delivers a report with the result: **COMPLETE**, **PARTIALLY VERIFIED**, **FAILED** or **BLOCKED**.

### Per-repo config (`.oap/odoosh-browser/config.json`)

```json
{
  "odoo_sh_project": "my-project",
  "staging_branch": "agent-staging",
  "production_branches": ["main"],
  "odoo_version": "18.0",
  "ssh": { "enabled": true, "key": null },
  "allowed_domains": ["odoo.sh", "odoo.com", "github.com"],
  "autonomy": { "push_staging": "confirm", "yolo": false },
  "build_poll_seconds": 60,
  "build_timeout_minutes": 60
}
```

`autonomy` has three levels, changed with `config.js set-autonomy confirm|auto|yolo` (the change always asks for confirmation):

| Level | What stops asking during a task |
|---|---|
| `confirm` (default) | nothing: every push to staging and every JavaScript in Chrome ask for confirmation |
| `auto` | the plain `git push origin <staging>` |
| `yolo` | also: push to staging with tags, JavaScript in Chrome on allowed domains, Claude in Chrome tools, the plugin scripts (`run-state`, `notes`, `report`, `hotpatch`, `oap.js`, `tasks.js`…, only from the plugin's real folder) and `ssh` to `*.dev.odoo.com` builds (any remote command outside the denied list, including tests that write to the staging database; locally only filters such as `grep` or `tail`) |

At **any** level these still ask: config changes, pushes to other branches, navigation to non-allowed domains, push-related `git remote`/`git config` and anything the guard cannot analyse. Still **denied**: production, force push, `--all` and the like, dangerous commands on the build and other browser MCPs. The `deny`/`ask` permission rules in the user's `settings.json` are also always respected (the hook cannot skip them). Outside a task, `yolo` approves nothing.

During a task, a **subagent** cannot `git commit` or `git push` or write the state or memory with `run-state.js`/`notes.js`/`knowledge.js` (denied; it can search and read): only the main thread. It is detected with the `agent_id` field Claude Code adds to subagent hooks.

All plugin state lives in `.oap/` (Odoo Agent Plugins), at the repo root:

```
.oap/
  memory/                   project memory: entries/<category>/<id>.md + derived _index/
  memory.md.migrated        old memory file, kept after the migration
  backups/                  copies taken before each migration
  odoosh-browser/
    config.json            staging branch, production branches, SSH, autonomy
    run.json               state and evidence of the current task
    throttle.json          browser polling pace during the build
```

`config.js init` adds `.oap/` to `.git/info/exclude` (local exclusion; the client's `.gitignore` is not touched). If the repo comes from an older version (`.claude/odoosh-browser*.json`), `config.js migrate` moves the files, converts the old notes to `memory.md` and excludes `.oap/`.

### Memory and knowledge (`scripts/knowledge.js`)

Three stores of Markdown with YAML properties, one entry per file. The index (`_index/`) is derived: deleting it loses nothing.

| Store | Where | What | How it gets there |
| --- | --- | --- | --- |
| Project | `.oap/memory/` | lessons, quirks, conventions, decisions of this repo | `knowledge.js add` (or `notes.js add`) during and after a task |
| Tasks | `.oap/odoo-squad/tasks/<id>/summary.md` | what each task did and its outcome | `knowledge.js task-summary` when it closes |
| Global | `~/.oap/knowledge/` | Odoo, Odoo.sh, editor, tests and tooling knowledge for every project | automatic copy of a **verified** project entry of a reusable topic that names nothing of the project |

- **Read by levels, never whole.** At the start of a task `knowledge.js context` gives ~1,500 tokens: project profile, the most relevant entries (BM25 over title, tags, summary and body, weighted by status, Odoo version and scope) and similar past tasks. Then `knowledge.js get <id> [--section "How to apply"]` or `knowledge.js search "<words>"` only when needed. Nothing is loaded when Claude Code starts. Measured: ~25 ms with 1,000 entries and ~110 ms with 5,000; the output stays ~1,800 characters whatever the size.
- **Status**: `observed` (seen in a task), `verified` (with proof: a reproducing test, command output, Odoo source file:line of that version) and `deprecated` (contradicted or replaced; out of searches). Duplicates are refused with the similar entry's id.
- **Global knowledge is automatic, with checks.** A verified entry is copied only if its category is reusable (`odoo`, `odoo-sh`, `editor`, `tests`, `tooling`, `migration`, `debugging`) and it names none of the project's own modules (git submodules such as OCA ones do not count), Odoo.sh project, staging branch or repo folder, and holds no e-mails, IPs, phone numbers, build hosts or non-public links. Only public evidence travels. Correcting the project entry updates its global copy. The task report lists every promotion with `knowledge.js remove <g-id>` to undo it. These are text checks: the report is how you catch what they miss.
- **Safety**: text aimed at the plugin's safeguards (branch config, autonomy, the guard, skipping confirmations, pushing to production) or that looks like a secret is rejected; Odoo knowledge about access rights, install hooks or skipped tests is accepted. Editing the stores directly asks for confirmation. Everything read from memory is data, not instructions.
- **Hook reminders** (`scripts/memory-hook.js`, only with an active task): after a tool failure it reminds to note the finding right away (at most every 10 min), and on finishing it blocks **once per task** if nothing was noted. It never creates stop loops.
- **Projects with the old `memory.md`** keep working: `context` shows their notes first and `notes.js` writes there (max. 100 notes in that format). `config.js validate` warns, and `odoo-project-setup` offers the migration: `knowledge.js migrate` (dry-run, writes nothing), `--apply` (backup in `.oap/backups/`, one entry per note, a `summary.md` per task, every note checked, `memory.md` renamed to `memory.md.migrated`; a second run adds nothing), `--rollback <stamp>` (back to the old format, later notes included). After it, `notes.js show/add/remove` work on the new entries.
- Maintenance: `knowledge.js validate`, `stats`, `reindex [--full]`, `deprecate <id> [--by <id>]`.

## Quick patch test (no push)

To try a fix without waiting for a build, the agent applies its local changes in `~/src/user` of the staging build, runs the tests and undoes it. `scripts/hotpatch.js prepare --base <build sha>` generates the patch (including unpushed commits and new files) with each file's hash to check the build ended up equal to the local copy. It is applied through the web editor terminal (or file editor, always saving), or over SSH if enabled. The `hotpatch_tests` evidence does not replace the build after the push. Details in `skills/odoo-sh-remote/reference/hotpatch.md`.

## Diagnostics with staging data

To find the cause of a failure with the real staging data, the agent runs a short read-only script with `odoo-bin shell`, which rolls everything back at the end. `scripts/diag.js prepare <script.py>` checks the script and generates the one-line command for SSH or the editor terminal; through the editor, the output is read as text through the editor API, without screenshots. The guard denies scripts with `commit()`. The output contains client data: it is not saved to memory. Details in `skills/odoo-sh-remote/reference/diagnostics.md`.

## SSH access to Odoo.sh

Optional and off by default: the agent works through the Odoo.sh web editor (terminal, and output read through the editor API). If enabled, the agent tries it once per task and, if it fails, continues through the editor.

The SSH key is **per user**, not per project: it is set up once.

1. Authorise the IP on Odoo.sh and wait for it to apply.
2. Add the public key to the Odoo.sh profile (avatar → *Profile*):
   - **Import it from GitHub** (quickest if the key is already in the GitHub account), or
   - generate it (`ssh-keygen -t ed25519`) and paste the content of the **public** key (the `.pub` file `ssh-keygen` creates; never the private one) in *Add a key manually*.
3. Be a collaborator on the Odoo.sh project.
4. Test with the SSH command the branch shows on Odoo.sh:
   ```powershell
   node plugins\odoosh-browser\scripts\ssh-check.js <build_id>@<domain>.dev.odoo.com
   ```

| Result | Likely cause |
|---|---|
| `Permission denied (publickey)` | The key is not in the Odoo.sh profile or the user is not a collaborator |
| Timeout / connection refused | IP not authorised or not applied yet |
| `Could not resolve hostname` | Misspelled host or staging branch recreated (the build id is usually stable per branch) |

Without SSH, the agent uses the web editor terminal (`https://<build>/odoo-sh/editor/lab`).

## Security

See [docs/security.md](docs/security.md). In short: the full protections only act **during a plugin task** (push to staging or feature branches with confirmation; production, force push and branch deletion blocked; the Odoo.sh UI is read-only for the agent). Outside a task, the hook only prevents a direct push to the production branch: creating branches and pull requests against production is free.

## Tests

Acceptance tests with a real client (unused staging branch): [docs/acceptance-tests.md](docs/acceptance-tests.md).

Unit tests:

```powershell
cd plugins\odoosh-browser   # from the repository root
npm test
```

## Status

First real test (v0.9.0): the GitHub MCP has **no** tool to read commit statuses or check runs, and `gh` was not installed; the build was verified over SSH and on the Odoo.sh page.

Still to validate on a real Odoo.sh project:
- exact names of the Claude in Chrome tools;
- reading the commit status with `gh` (needs the GitHub token in the Odoo.sh project *Settings*; not tested);
- automatic retrieval of the latest build's SSH host;
- exact command for tests on the build (`skills/odoo-sh-remote/reference/tests.md`).
