# Diagnostics with staging data (`odoo-bin shell`, read-only)

To understand a failure with the real data of the staging build before touching code: read records, compute a field, count affected cases or, with the user's OK, call the failing method and see its traceback. It helps find the cause and write a regression test that reproduces it; it does not replace that test or `remote_tests`.

## Rules

- Only on the **staging** build of the task (`*.dev.odoo.com`), never on production.
- **Read-only.** The script **never** calls `commit()`; whatever it writes inside the transaction is rolled back. Verified in the Odoo 15.0 to 19.0 code (`odoo/cli/shell.py`) and on an Odoo 18 build: when the script ends the shell runs `cr.rollback()` and nothing is saved. `diag.js` also adds an explicit `rollback()`.
- **What the rollback does not undo**:
  - methods that commit on their own (crons, mail sending with `auto_commit`, queues);
  - **calls to external services**: mail, HTTP, EDI, tax connectors (e.g. SII or the AEAT checks in `l10n-spain`), payment gateways. **[unverified]** that the Odoo.sh staging neutralisation blocks them in OCA or custom modules.

  By default, diagnostics only **read** (`search`, `read`, computed fields, `_compute_*`). Call a business method (`action_confirm`, `action_post`, `write` with automations…) only with the user's explicit OK and after checking it contacts nothing external; if that cannot be ensured, reproduce the failure in a test.
- The guard decodes the script (it travels in base64 inside the command) and denies `commit(`, `auto_commit=True` and write SQL. An `odoo-bin shell` with the script outside the command (`< file`, interactive console) asks for confirmation: it cannot be reviewed.
- **Client data**: staging is a neutralised copy of production with real data. The output is used in the task and the local report; it **never** goes to the project memory (`notes.js`) or the repo. Print only what is needed (ids, counts, states), not client names, emails or amounts unless they are needed.
- Never type in the *Odoo shell* console the editor opens: it runs with an open transaction.

## 1. Prepare (local)

Write the script in a local file (e.g. `.oap/odoosh-browser/diag/case.py`) using `env`, as in the shell:
```python
so = env['sale.order'].browse(1234)
print('state', so.state, 'lines', len(so.order_line))
print('computed amount', so.amount_total, 'taxes', so.order_line.tax_id.ids)
```
Then:
```bash
node <plugin>/scripts/diag.js prepare .oap/odoosh-browser/diag/case.py
```
It checks the script, wraps it (script errors come out in normal output, with `rollback()` at the end) and prints the one-line commands. It does not connect to the build. Maximum about 6 KB of script: split anything larger.

## 2a. Run over SSH

With the **Bash** tool (single quotes, so `$PGDATABASE` expands on the build and not locally), replacing `<build>`:
```bash
ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new <build> 'echo <base64> | base64 -d | odoo-bin shell -d "$PGDATABASE" --no-http --log-level=error >/tmp/oap-diag.out 2>/tmp/oap-diag.err; echo EXIT=$?; head -c 20000 /tmp/oap-diag.out; tail -n 3 /tmp/oap-diag.err; rm /tmp/oap-diag.out /tmp/oap-diag.err'
```

## 2b. Run through the editor terminal

1. Open a terminal (*File → New → Terminal*) and type the editor command `diag.js` prints, on one line; the output goes to `~/oap-diag.txt` (cut at 20 KB).
2. Wait for `EXIT=` in the terminal (about 15-30 s: the shell loads the registry).
3. Read the output **as text**, without screenshots, in another tab: `https://<build>/odoo-sh/editor/api/contents/oap-diag.txt?content=1&format=text&type=file` with `get_page_text` ([editor-jupyterlab.md](editor-jupyterlab.md) §3).
4. Delete: `rm ~/oap-diag.txt`.

## 3. Interpret

- `EXIT=0` and the script's output: the script ran; a script error shows as a traceback **inside** the output.
- `EXIT` other than 0 and empty output: the shell did not start (database, a module that fails to load); check the last error lines the command prints.
- What the diagnostics confirm goes into a regression test ([tests.md](tests.md), and in the squad to the fixer). If it shows a fact useful for other tasks (a field, a method, a version quirk), note it with `notes.js` **without client data**.
