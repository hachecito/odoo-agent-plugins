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

## Requirements

- [Claude Code](https://code.claude.com/docs) and Node.js 18 or later.
- [Claude in Chrome](https://code.claude.com/docs/en/chrome) logged in to Odoo.sh, to read builds and logs and use the web editor.
- `git` and, for pull requests, the `gh` CLI logged in.
- SSH to Odoo.sh is optional and off by default.

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

### Utilities (PowerShell)

```powershell
node <plugin>\scripts\notes.js show                       # project memory (.oap/memory.md)
node <plugin>\scripts\config.js validate                  # repo configuration
node <plugin>\scripts\config.js set-autonomy auto         # push to staging without confirming (production stays denied)
node <plugin>\scripts\config.js set-autonomy yolo         # also Chrome, plugin scripts and ssh to staging without confirming
node <plugin>\scripts\config.js migrate                   # move the old .claude/ files to .oap/
```

Both plugins share the repo's `.oap/` folder (excluded from git): configuration, task state and `memory.md` with what was learned.

## Updating

```powershell
claude plugin marketplace update odoo-agent-plugins
claude plugin update odoosh-browser@odoo-agent-plugins     # check claude plugin list --> new version
claude plugin update odoo-squad@odoo-agent-plugins
```

## Structure

```
.claude-plugin/marketplace.json   plugin catalogue of this repository
plugins/<plugin>/                 one plugin per folder (plugin.json, skills, agents, hooks, scripts, docs, tests)
```

## License

[MIT](LICENSE) © 2026 hachecito
