<div align="center">

# Odoo Agent Plugins

Claude Code plugins that take an Odoo task from start to finish: code and tests, push to an Odoo.sh staging branch, build verification and a report with evidence, with safeguards that keep production out of reach.

[![MIT license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-d97757.svg)](https://code.claude.com/docs/en/plugins)
[![Agent skills](https://img.shields.io/badge/agent-skills-3b82f6.svg)](plugins/)
[![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Odoo.sh](https://img.shields.io/badge/Odoo.sh-staging-714b67.svg)](https://www.odoo.sh/)
[![Gitleaks](https://github.com/hachecito/odoo-agent-plugins/actions/workflows/gitleaks.yml/badge.svg)](https://github.com/hachecito/odoo-agent-plugins/actions/workflows/gitleaks.yml)

<img src="docs/assets/oap-banner.png" alt="OAP, Odoo Agent Plugins" width="820">

</div>

## Plugins

| Plugin | Description |
|---|---|
| [odoosh-browser](plugins/odoosh-browser/README.md) | End-to-end Odoo tasks on an Odoo.sh staging branch: code and tests, commit, push with confirmation, build, logs and tests verification (Odoo.sh web editor with Claude in Chrome, or SSH) and a report with evidence. |
| [odoo-squad](plugins/odoo-squad/README.md) | Squad of autonomous agents that runs a documented task end to end: plans, implements, tests, fixes, consults an advisor and writes the report. Requires `odoosh-browser`. |
| [oap-memory](plugins/oap-memory/README.md) | Shared memory of the other plugins: project memory, task summaries and global knowledge with indexed search, automatic promotion and safeguards. Installed automatically as a dependency. |
| [odoo-local-env](plugins/odoo-local-env/README.md) | Local Odoo environments on Docker for tests: restores an Odoo.sh backup or creates an empty database, with the repo's modules and Enterprise; upgrades and tests modules; keeps or cleans up environments. Independent: the other plugins do not use it. |

## Requirements

- [Claude Code](https://code.claude.com/docs) and Node.js 18 or later.
- [Claude in Chrome](https://code.claude.com/docs/en/chrome) logged in to Odoo.sh, to read builds and logs and use the web editor.
- `git` and, for pull requests, the `gh` CLI logged in.
- SSH to Odoo.sh is optional and off by default.
- Recommended: the [context7](https://claude.com/marketplace/plugins/context7) plugin, to look up Odoo documentation before reading Odoo's source. It is optional: without it the agents read the Odoo source of the project's version. Install it with `claude plugin install context7@claude-plugins-official`.

## Installation

```powershell
claude plugin marketplace add hachecito/odoo-agent-plugins      # or the local path of this repository
claude plugin install <plugin>@odoo-agent-plugins
```

## Basic usage

Set up **once per repo** of Odoo modules (asks for the Odoo.sh staging branch and checks Chrome, GitHub and SSH):

```
/odoosh-browser:odoo-project-setup
```

### odoosh-browser: one agent, one task

When you want to follow a specific task closely:

```
/odoosh-browser:odoo-task Fix the discount calculation in sale_custom and add a test
```

It writes code and tests, commits, pushes to staging (with confirmation), waits for the build, reads the logs, runs the tests on Odoo.sh and delivers a report with evidence.

### odoo-squad: a team of agents, documented task

When you want to delegate the whole task. Pass it an `.md` file (or a description):

```
/odoo-squad:squad-run tasks/discounts.md
/odoo-squad:squad-run "Add a 'customer reference' field to sale.order and show it in the list view"
```

A planner, an implementer, a tester, a fixer, an advisor (most capable model, only for hard decisions) and a writer (message drafts) work on top of the same safeguards. Requires `odoosh-browser` installed.

### odoo-local-env: a local Odoo on Docker

Only when you ask for it. Needs Docker (Docker Desktop on Windows/macOS) running:

```
/odoo-local-env:local-env mount a local environment of this repo, Odoo 19, with the backup <path/to/backup.zip>
```

## Memory: every task makes the next one faster

The agents remember what they learn, find it again by searching instead of re-reading everything, and share what is reusable across projects.

| Memory | Where | What it keeps |
|---|---|---|
| Project | `.oap/memory/` in each repo | lessons, quirks, conventions and decisions of that project |
| Tasks | `.oap/odoo-squad/tasks/<id>/summary.md` | what each task did and how it ended |
| Global | `~/.oap/knowledge/` | Odoo, Odoo.sh, editor, tests and tooling knowledge for every project |

- **Cheap to read**: at the start of a task the agent gets about 1,500 tokens with the project profile, the most relevant entries and similar past tasks, whatever the size of the memory. Entries are opened one by one, or one section at a time, only when needed. Nothing is loaded when Claude Code starts.
- **Search, not files**: a keyword index (BM25) over Markdown files with YAML properties; no database, no embeddings, no extra dependencies. About 25 ms with 1,000 entries and 110 ms with 5,000.
- **Learning with evidence**: lessons are saved as `observed`; with a proof (a reproducing test, command output, the Odoo source of that version) they become `verified`.
- **Shared automatically, project data kept local**: a verified lesson on a reusable topic is copied to the global memory when it names nothing of the project (own modules, Odoo.sh project, staging branch, hosts, e-mails, private links). The task report lists every promotion and how to remove it.
- **Safe**: memory is data, never instructions; text aimed at the plugin's safeguards or that looks like a secret is rejected; only the main agent writes it.
- **Upgrading from `.oap/memory.md`**: the setup detects the old format and offers `knowledge.js migrate` (dry-run first, backup, verification, rollback).
- **One memory for every plugin**: it lives in the `oap-memory` plugin, which the others declare as a dependency. A new plugin of this marketplace gets the memory with a dependency, a `memory.json` and a few lines in its skills.

Details in the [oap-memory README](plugins/oap-memory/README.md).

### Utilities (PowerShell)

```powershell
node <plugin>\scripts\mem.js search "picking lots"        # search project and global memory (mem.js of any plugin)
node <plugin>\scripts\mem.js stats                        # what the memory holds
node <plugin>\scripts\mem.js migrate                      # old memory.md: dry-run, then --apply
node <plugin>\scripts\config.js validate                  # repo configuration
node <plugin>\scripts\config.js set-autonomy auto         # push to staging without confirming (production stays denied)
node <plugin>\scripts\config.js set-autonomy yolo         # also Chrome, plugin scripts and ssh to staging without confirming
node <plugin>\scripts\config.js migrate                   # move the old .claude/ files to .oap/
```

All plugins share the repo's `.oap/` folder (excluded from git): configuration, task state, task folders and the project memory.

## Updating

```powershell
claude plugin marketplace update odoo-agent-plugins
claude plugin update odoosh-browser@odoo-agent-plugins     # check claude plugin list --> new version
claude plugin update odoo-squad@odoo-agent-plugins
claude plugin update oap-memory@odoo-agent-plugins         # installed on its own the first time, as a dependency
claude plugin update odoo-local-env@odoo-agent-plugins     # only if you installed it
```

## Structure

```
.claude-plugin/marketplace.json   plugin catalogue of this repository
plugins/<plugin>/                 one plugin per folder (plugin.json, skills, agents, hooks, scripts, docs, tests)
```

## License

[MIT](LICENSE) © 2026 hachecito
