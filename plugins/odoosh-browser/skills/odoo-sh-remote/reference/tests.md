# Running tests on an Odoo.sh build

## Verified command (real test on a client staging build)

```bash
odoo-bin -d "$PGDATABASE" -u <module> --stop-after-init --no-http \
  --test-enable --test-tags /<module> --logfile=/tmp/agent-tests.log --log-level=test
```

Then:

```bash
grep -n 'FAIL:\|ERROR:\|tests.result' /tmp/agent-tests.log | tail -n 50
```

- The test used the full path `/opt/odoo.sh/odoosh/bin/odoo-bin`. If `odoo-bin` is not on the PATH of the terminal or SSH, use that path.
- `--test-tags /<module>` is **essential**: with `--test-enable` alone, the tests of every installed module run (slow and unnecessary).
- `--no-http` is the pattern Odoo.sh's own `odoo-update` uses and avoids clashing with the running server. Not tested without it: keep it.
- `--logfile` leaves the output in a file: needed with the web terminal, whose text cannot be read as text (see [editor-jupyterlab.md](editor-jupyterlab.md)).
- Several modules: `-u mod_a,mod_b --test-tags /mod_a,/mod_b`.

Official reference (*Odoo.sh → Advanced → Containers*), for a module being installed: `odoo-bin -i <module> --test-enable --log-level=test --stop-after-init`.

## Reading the output

- Success: `odoo.tests.result: 0 failed, 0 error(s) of N tests` (the format varies by version). Note N.
- Failure: `FAIL:` / `ERROR:` followed by a traceback. See the whole block with `grep -n -A 30 'FAIL:\|ERROR:' /tmp/agent-tests.log | head -n 120` and keep it as evidence.
- No tests run (0 tests): the module has no tests or the tag is wrong; it does not count as `pass`.
- When done: `rm /tmp/agent-tests.log`.

## Reminder

The official documentation warns that these operations are **not isolated**: `-u` updates the module in the build's database. On staging (neutralised copy of production) that is acceptable; never on production.
