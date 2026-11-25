# Quick patch test on the staging build (before the push)

Try a change on the running staging build without commit, push or waiting for a build: the local changes are applied in the build's `~/src/user`, the tests run and the change is undone. What is delivered is still what Odoo.sh builds after the push: this test does **not replace** `remote_build` or `remote_tests`.

## Rules

- Only on the task's **staging** build (`*.dev.odoo.com`), only in `~/src/user`. Never in `~/src/odoo` or `~/src/enterprise`, never on production.
- **Local code rules**: the change is made first in the local repo and taken to the build as is. If it is edited in the editor, the result must match the local one (hash check, below).
- **Staging is shared**: the tests' `-u` changes its database and saving a `.py` in the editor restarts the server. Tell the user the first time in each task.
- **Always undo**: before the push and when closing the task (completed, blocked or abandoned). The next build discards it, but meanwhile staging runs code that is not in git.
- Its own evidence: `run-state.js evidence --kind hotpatch_tests ...`. Never record it as `remote_tests`.
- **Verified on an Odoo 18 staging build (November 2026)**: `~/src/user` is a git checkout at the build's commit, writable, with `git` 2.43 and `base64`; the base64 patch typed in the web terminal applied with the same `git hash-object` as locally, and `git apply -R` undid it completely, including new files and folders. Check it anyway on first use in each project (`git -C ~/src/user rev-parse HEAD`). If a build were not a git checkout: `git apply` also works outside a repository, and instead of `git status` check with the patch itself: `git apply -R --check ~/oap-hotpatch.patch` succeeds if the patch **is still applied**, and if no `~/oap-hotpatch.patch` is left there is no agent patch.

## 1. Prepare the patch (local)

1. Build SHA: `git -C ~/src/user rev-parse --short=12 HEAD` over SSH or in the editor terminal (12 characters read better in a screenshot), or the commit the branch shows on Odoo.sh. If it does not exist locally, `git fetch`.
2. `node <plugin>/scripts/hotpatch.js prepare --base <sha>` (add `--only <path>` for a partial patch, e.g. only the tests). It writes to `.oap/odoosh-browser/hotpatch/`:
   - `patch.diff`: unpushed local commits, uncommitted changes and new files relative to the build;
   - `patch.b64`: the same patch in base64, to type in the web terminal;
   - `manifest.json`: files and their `git hash-object`.
   It prints the exact commands for SSH and for the editor. It does not connect to the build.
3. **Review the file list before applying.** The full patch includes everything git does not ignore, also loose untracked files (test scripts, an `odoo.conf`, `.env`…), which the script lists separately. If anything outside the task's modules shows up, repeat with `--only <module> [--only <module>...]`. Never take files with credentials or client data to the build.

## 2a. Apply over SSH (only if `ssh.enabled` and it answered)

With `ssh.enabled` and the build host; `ssh <build>` abbreviates `ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new <build_id>@<build_domain>` (`SKILL.md`, Context). On Windows, with the **Bash** tool (Git Bash): PowerShell 5.1 does not support `<` redirection and piping the patch through PowerShell re-encodes and breaks it.
```bash
ssh <build> "cd ~/src/user && git rev-parse HEAD && git status --porcelain"     # HEAD = base; no foreign changes
ssh <build> "cat > ~/oap-hotpatch.patch && cd ~/src/user && git apply --check ~/oap-hotpatch.patch && git apply ~/oap-hotpatch.patch" < .oap/odoosh-browser/hotpatch/patch.diff
ssh <build> "cd ~/src/user && git hash-object <files> | cut -c1-12"           # same as the manifest
```
If `git status --porcelain` is not empty, someone else or an earlier patch left changes: do not apply on top; ask the user. If SSH fails for any reason, continue through the editor for the rest of the task, without retrying (`SKILL.md`, Channels).

## 2b. Apply through the editor (main channel)

Open `https://<build>/odoo-sh/editor` and a terminal (*File → New → Terminal*). Read [editor-jupyterlab.md](editor-jupyterlab.md) §5 for reading terminal output.

**Everything through the terminal**: it can write to `~/src/user`, so creating and changing files with commands (`mkdir -p`, `cat`/`base64 -d` with a heredoc, `sed -i`) is cheaper and more reliable than the file editor: no clicks or auto-indent, and the result is checked in the same terminal. Order of preference: A, then B; the file editor (C) only if the terminal is unavailable.

**Option A — full patch (preferred).** Type the content of `patch.b64` between these lines:
```bash
base64 -d > ~/oap-hotpatch.patch <<'OAP_EOF'
<lines of patch.b64>
OAP_EOF
cd ~/src/user && git status --porcelain && git apply --check ~/oap-hotpatch.patch && git apply ~/oap-hotpatch.patch
git hash-object <files> | cut -c1-12
```
Base64 is used because it has no tabs (which the terminal would take as autocomplete) and no code text the guard could mistake for a forbidden command.

**Option B — file by file in the terminal** (a new file or a small change, or if `git apply` fails). Verified: a file written with `base64 -d` keeps its tabs and `sed -i` changes the line; the hash matches the local one. With the content of the local file:
```bash
mkdir -p ~/src/user/<module>/tests
base64 -d > ~/src/user/<path> <<'OAP_EOF'      # full content of the local file in base64
<base64 of the file>
OAP_EOF
sed -i 's/<exact text>/<new>/' ~/src/user/<path>   # only for a simple line
cd ~/src/user && git hash-object <path> | cut -c1-12    # same as the manifest
```
- For a whole file, base64 beats plain text: Python code has indentation and sometimes tabs or text (e.g. SQL in `cr.execute`) that the terminal or the guard would misread.
- No interactive editors (`nano`, `vim`): they are driven blind through screenshots and what was written cannot be checked until exiting.
- **[unverified]** whether writing a `.py` from the terminal restarts the server as saving in the editor does. It does not matter for tests: they run in a separate process.

**Option C — file editor (last resort).**
1. Open the file with `https://<build>/odoo-sh/editor/lab/tree/src/user/<path>`. New file: navigate to its folder, *File → New → Text File* (or *Python File*) and rename it to its real name (right click on the tab or in the file browser → *Rename*).
2. Edit. **[unverified]** the editor may auto-indent and close brackets or quotes while typing: check the result before saving.
3. **Always save**: `Ctrl+S` or *File → Save*. Unsaved, the change does not exist on disk and the test would try the old code. Saving a `.py` restarts the staging server.
4. Check from the terminal that what was saved matches the local file: `cd ~/src/user && git hash-object <file> | cut -c1-12` against `manifest.json`. A tab without a modified mark is not enough.

## 3. Test

With the patch applied, run the tests in a separate process, as in [tests.md](tests.md): it reads the patched code without restarting the server.
```bash
odoo-bin -d "$PGDATABASE" -u <module> --stop-after-init --no-http --test-enable --test-tags /<module>:<Class>.<method> --logfile=/tmp/agent-tests.log --log-level=test
grep -n 'FAIL:\|ERROR:\|tests.result\|Ran ' /tmp/agent-tests.log | tail -n 40
```
For a regression test: first a patch with only the module's tests folder (`--only <module>/tests`, so `tests/__init__.py` goes too) and it must **fail**; then undo, prepare the full patch and it must **pass**. It only counts as red if N > 0 tests run and the regression test fails on its assertion; 0 tests, an `ImportError` or a module load error reproduce nothing.

Record `hotpatch_tests` with the base SHA, the patch (`--only` or full), the command, N tests and the result.

## 4. Undo

```bash
cd ~/src/user && git apply -R ~/oap-hotpatch.patch && git status --porcelain && rm ~/oap-hotpatch.patch
```
Over SSH, the same command inside `ssh <build> "..."`. If files were changed one by one (options B or C) without a patch, `git checkout -- <files>` and delete new files with `rm <file>` (no `-rf`). Before a new patch, undo the previous one.
