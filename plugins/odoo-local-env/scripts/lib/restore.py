"""Restore an Odoo backup into the environment's Postgres and filestore. Runs inside the Odoo container.

Accepts an Odoo.sh / database manager .zip (dump.sql or dump.dump plus filestore/), a pg_dump custom file (.dump)
or a plain .sql (optionally with --filestore-tar). The dump is streamed (never extracted to disk). Usage:
restore.py --src /backup/<file> --db <name> --filestore /var/lib/odoo/filestore
"""
import argparse
import os
import shutil
import subprocess
import tarfile
import tempfile
import sys
import zipfile

CHUNK = 1024 * 1024


def run_stream(cmd, stream):
    """Pipe a binary stream into a command; fail on a non-zero exit and summarize the SQL errors."""
    with tempfile.TemporaryFile() as err:
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=err)
        try:
            shutil.copyfileobj(stream, proc.stdin, CHUNK)
        finally:
            proc.stdin.close()
        code = proc.wait()
        err.seek(0)
        errors = [l for l in err.read().decode("utf-8", "replace").splitlines() if l.startswith("ERROR")]
    if errors:
        print(">> WARNING: %d SQL errors while loading the dump; first ones:" % len(errors), flush=True)
        for line in sorted(set(errors))[:10]:
            print("   " + line, flush=True)
    if code != 0:
        sys.exit("restore failed: %s exited with %s" % (cmd[0], code))


def load(db, name, stream):
    """Load a plain SQL or a custom-format dump stream into the database."""
    if name.endswith(".dump"):
        run_stream(["pg_restore", "--no-owner", "--no-privileges", "-d", db], stream)
    else:
        run_stream(["psql", "-q", "-v", "ON_ERROR_STOP=0", "-o", "/dev/null", "-d", db], stream)


def main():
    """Create the database and load dump and filestore."""
    p = argparse.ArgumentParser()
    p.add_argument("--src", required=True)
    p.add_argument("--db", required=True)
    p.add_argument("--filestore", required=True)
    p.add_argument("--filestore-tar", help="tar of the filestore folder (from Odoo.sh over SSH)")
    a = p.parse_args()
    subprocess.check_call(["createdb", "-T", "template0", "-E", "UTF8", a.db])
    print(">> database %s created" % a.db, flush=True)
    if a.src.endswith(".zip"):
        with zipfile.ZipFile(a.src) as z:
            names = z.namelist()
            dump = next((n for n in ("dump.sql", "dump.dump") if n in names), None)
            if not dump:
                sys.exit("restore failed: the zip has no dump.sql or dump.dump")
            print(">> loading %s (this can take several minutes)" % dump, flush=True)
            with z.open(dump) as s:
                load(a.db, dump, s)
            target = os.path.join(a.filestore, a.db)
            files = [n for n in names if n.startswith("filestore/") and not n.endswith("/")]
            print(">> copying filestore: %d files" % len(files), flush=True)
            for n in files:
                dest = os.path.join(target, n[len("filestore/"):])
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                with z.open(n) as src, open(dest, "wb") as out:
                    shutil.copyfileobj(src, out, CHUNK)
    else:
        print(">> loading %s (this can take several minutes)" % os.path.basename(a.src), flush=True)
        with open(a.src, "rb") as s:
            load(a.db, a.src, s)
        if a.filestore_tar:
            target = os.path.join(a.filestore, a.db)
            os.makedirs(target, exist_ok=True)
            with tarfile.open(a.filestore_tar) as t:
                members = [m for m in t.getmembers() if m.isfile() or m.isdir()]
                print(">> copying filestore: %d entries" % len(members), flush=True)
                # 'data' filter (no absolute paths, links out of the target) where this Python supports it.
                t.extractall(target, members=members, **({"filter": "data"} if hasattr(tarfile, "data_filter") else {}))
        else:
            print(">> no filestore in a bare dump: attachments will be missing", flush=True)
    print(">> restore done", flush=True)


if __name__ == "__main__":
    main()
