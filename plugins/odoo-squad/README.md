# odoo-squad

Squad of autonomous Odoo agents. Give it a documented task and it carries it out end to end: plans, implements, tests, fixes and verifies on Odoo.sh staging, and learns from the project. It uses the safeguards and state of `odoosh-browser` and the memory of `oap-memory`, both **required** and installed with it as dependencies.

## Usage

```powershell
claude plugin install odoosh-browser@odoo-agent-plugins
claude plugin install odoo-squad@odoo-agent-plugins
```

In a modules repo where `/odoosh-browser:odoo-project-setup` has already been run:

```
/odoo-squad:squad-run task.md        # or a text description
```

## Agents

| Agent | Model | Role |
|---|---|---|
| `squad-planner` | sonnet | task questions before the plan; plan with acceptance criteria; revises it if the approach fails |
| `squad-implementer` | opus | code and tests following the plan |
| `squad-tester` | sonnet | local checks, test patch on the build and tests on Odoo.sh; returns evidence |
| `squad-fixer` | sonnet | root cause, regression test that reproduces the failure and minimal fix |
| `squad-advisor` | opus | consultation only: settles task questions, complex decisions, blockers, irreversible actions |
| `squad-writer` | haiku | summary, PR description and client message drafts (never sends anything) |

The models are aliases (`sonnet`, `opus`, `haiku`) pointing to the latest version; change them in each agent's frontmatter.

The orchestrator is the `squad-run` skill (main thread), because a subagent cannot launch others. Only the orchestrator writes to `.oap/`, commits and pushes.

## Flow

```
task → planner(questions) → advisor → user (only what the advisor cannot decide) → planner(plan) → implementer → tester(local) → commit/push staging → tester(remote)
                                   │ failure                                │ failure
                                   └──────────► fixer ◄─────────────────────┘
                                   (max. 3 cycles; advisor if blocked) → verifier → writer → report
```

## Clarification before the plan

Before planning, the planner lists the questions that would change the result (max. 4). The advisor decides those the repo code or the memory can answer, citing the proof; what depends on standard Odoo is checked in its code (GitHub, version branch) before it is accepted. Only questions that depend on the business or the client reach the user, all together in one message and with a recommended option. Everything goes to `aclaraciones.md`.

## Failures: regression test first

When a phase fails, the fixer first writes a test that reproduces the failure and then the fix, and the tester runs it isolated on Odoo.sh (`--test-tags /<module>:<Class>.<method>`) to confirm it ran. Without a local environment, the fixer explains which assertion fails without the fix; failures that are not logic errors (build, dependencies, staging data) get no test.

## Quick test on the build (no push)

In the fix loop, if a staging build is running, the tester applies a patch to it with only the regression test (must fail) and then with the fix (must pass), over SSH or from the web editor, and undoes it. That checks the fix without waiting for a build; then commit and push as usual. Details in `odoosh-browser` (`odoo-sh-remote` §5).

## Autonomy

By default the push to staging and JavaScript in Chrome ask for confirmation, also when a subagent launches them; if nobody answers, the task stalls. Per project the level can be raised with `oap.js config.js set-autonomy auto|yolo` (asks for confirmation):

- `auto`: a plain push to staging no longer asks.
- `yolo`: also Chrome (including JavaScript on allowed domains), the plugin scripts and read-only `ssh` to staging builds.

Production, force push and the other denials stay the same at any level. Details in the `odoosh-browser` documentation.

Subagents cannot commit or push: the guard denies it and only the orchestrator does it.

## Memory and tasks

```
.oap/
  memory/                           project memory (oap-memory entries, shared with odoosh-browser)
  odoo-squad/tasks/
    index.md                        one line per task: id · status · title
    20261112-customer-reference/
      task.md                       the task as delivered
      aclaraciones.md               questions settled before the plan and who decided them
      plan.md                       the planner's plan (and its revisions)
      hallazgos.md                  details that only apply to this task
      summary.md                    what was done and the outcome (searchable)
~/.oap/knowledge/                   global knowledge shared by every project
```

- The orchestrator opens a memory session (`mem.js session start`), runs `mem.js context` once and hands its output to the planner, which reads an entry's file only when the summary is not enough and cites the ids it relies on. Other agents get only the cited entries; a new failure gets one `mem.js search` with at most 3 results.
- Agents return `[LESSON]` (with a suggested category and the proof they saw) and `[FINDING]`. Only the orchestrator records: lessons with `mem.js add`, proven ones as `verified`; findings in `hallazgos.md`; the task in `summary.md` with `mem.js task-summary`.
- Verified lessons of a reusable topic that name nothing of the project are copied to global knowledge automatically; the final report lists them and how to remove each one. Details in the [oap-memory README](../oap-memory/README.md).
- `scripts/tasks.js` creates the folders, maintains the index and migrates the 0.1.0 format (`tasks migrate`). Task statuses are `in-progress`, `completed`, `blocked`, `abandoned` and `migrated`; the Spanish ones from earlier versions are still accepted.
- The oap-memory hook (reminder to note findings) works while the memory session of `squad-run` is open.

## Planned (next versions)

- Local environment: global Postgres (Docker, config in `~/.oap/`, disposable databases prefixed `oap_`) and Odoo source code to run tests before the push.
- Check in a real session that the `yolo` mode `allow` avoids the questions from background subagents.

## Development

`npm test` (in this folder) and `claude plugin validate .\plugins\odoo-squad`.
