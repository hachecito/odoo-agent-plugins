# Installing on Windows

## Requirements

| Requirement | Check |
|---|---|
| Claude Code (logged in with `/login`, Pro/Max/Team/Enterprise plan for Claude in Chrome) | `claude --version` |
| Node.js 18+ (hooks and scripts) | `node -v` |
| Git | `git --version` |
| OpenSSH (included in Windows 10/11) | `ssh -V` |
| Google Chrome or Edge with the **Claude in Chrome** extension 1.0.36+ | Chrome Web Store |
| `github` MCP configured in Claude Code, or GitHub CLI (`gh`) | `/mcp` or `gh auth status` |
| context7 (Odoo documentation) | `/mcp` |

## 1. Install the plugin

From the repository published on GitHub:

```powershell
claude plugin marketplace add hachecito/odoo-agent-plugins
claude plugin install odoosh-browser@odoo-agent-plugins
```

From a local copy:

```powershell
claude plugin marketplace add C:\path\odoo-agent-plugins
claude plugin install odoosh-browser@odoo-agent-plugins
```

Check: `claude plugin validate C:\path\odoo-agent-plugins\plugins\odoosh-browser`.

## 2. Claude in Chrome

1. Install the Claude in Chrome extension and log in with the same account/organisation as Claude Code.
2. Start Claude Code with `claude --chrome` (or run `/chrome` inside the session; *Enabled by default* can be ticked there).
3. Log in to GitHub and Odoo.sh in that Chrome. The agent reuses the session; if it expires or asks for 2FA, it stops and says so.
4. See the available tools: `/mcp` → `claude-in-chrome` → *View tools*.

The existing `chrome-devtools` MCP config is not modified.

## 3. SSH to Odoo.sh

See the "SSH access to Odoo.sh" section of the [README](../README.md#ssh-access-to-odoosh).

## 4. Odoo.sh commit status on GitHub

Optional and **not tested yet**. According to the Odoo.sh documentation, a GitHub token with *Commit statuses (write)* permission can be added in *Settings* so Odoo.sh publishes each build's result on GitHub. Reading it needs `gh` (the GitHub MCP has no tool for commit statuses). Without it, the agent checks the build on the Odoo.sh branch page or over SSH, which is the tested route.

## 5. Prepare each modules repo

Inside Claude Code, in the repo: `/odoosh-browser:odoo-project-setup`.

## Common problems

| Symptom | Fix |
|---|---|
| The hook does not run | Check `node` is on the PATH; `/hooks` must list the plugin's hook |
| No `claude-in-chrome` tools | Start with `claude --chrome`; in `/chrome` use *Reconnect* |
| `Permission denied (publickey)` | Add the key to the Odoo.sh profile (import from GitHub or paste the `.pub`) |
| The push is always denied | `node <plugin>\scripts\config.js show`: check `staging_branch` and the current branch |
