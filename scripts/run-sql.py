#!/usr/bin/env python3
"""Run a SQL file against the kaviri database, by whichever route is available.

There are two ways into this database and a contributor will have one of them, rarely
both. Continuous integration brings up a plain Postgres container and has psql. A laptop
talking to the hosted project usually has neither psql nor the database password, but it
does have a Supabase access token. Rather than making every script care, the choice is
made once, here, and everything else calls this.

Route is decided in this order:

  DATABASE_URL is set and psql exists   psql, which is the route CI takes
  SUPABASE_PROJECT_REF is set           the Supabase Management API query endpoint

The access token is read from the environment if SUPABASE_ACCESS_TOKEN is set, and
otherwise from the desktop keyring where the Supabase CLI already keeps it. It is never
read from a file and never written to one, so nothing in this repository can come to
contain it by accident.

    scripts/run-sql.py supabase/migrations/*.sql
    scripts/run-sql.py --expect-failure supabase/tests/should_not_apply.sql
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request

API = "https://api.supabase.com"

# psql meta-commands are a psql feature, not SQL. They are meaningful on the psql route
# and a syntax error on the API route, so they are stripped there rather than being
# forbidden in the files, which would make the files less useful to a human with psql.
META = re.compile(r"^\s*\\[a-zA-Z]", re.MULTILINE)


def access_token():
    tok = os.environ.get("SUPABASE_ACCESS_TOKEN")
    if tok:
        return tok
    try:
        import gi

        gi.require_version("Secret", "1")
        from gi.repository import Secret
    except Exception:
        sys.exit(
            "No SUPABASE_ACCESS_TOKEN in the environment and no keyring available.\n"
            "Either export the token or set DATABASE_URL and use psql."
        )
    items = Secret.password_search_sync(
        None,
        {},
        Secret.SearchFlags.ALL | Secret.SearchFlags.UNLOCK | Secret.SearchFlags.LOAD_SECRETS,
        None,
    )
    # Matched on the Supabase CLI's own item rather than on the word "supabase", because
    # other kaviri secrets live in the same keyring and a loose match returns the wrong
    # one, which surfaces much later and confusingly as an undecodable JWT.
    for i in items:
        if (i.get_label() or "") == "keyring:supabase@Supabase CLI":
            return i.retrieve_secret_sync(None).get_text()
    sys.exit("No Supabase CLI token in the keyring. Run `supabase login` once.")


def run_api(ref, sql, token, timeout=600):
    body = json.dumps({"query": sql}).encode()
    req = urllib.request.Request(
        f"{API}/v1/projects/{ref}/database/query",
        data=body,
        method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode()
            return 0, (raw if raw.strip() else "")
    except urllib.error.HTTPError as e:
        return 1, e.read().decode()


def run_psql(url, path):
    # ON_ERROR_STOP is passed as a variable rather than relied on from the file, so that a
    # file which forgets it still fails the build instead of reporting success after an
    # error partway through.
    p = subprocess.run(
        ["psql", url, "-v", "ON_ERROR_STOP=1", "-X", "-q", "-f", path],
        capture_output=True,
        text=True,
    )
    return p.returncode, (p.stdout + p.stderr)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument(
        "--expect-failure",
        action="store_true",
        help="invert the exit code, for a negative test that proves a check can fail",
    )
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    url = os.environ.get("DATABASE_URL")
    ref = os.environ.get("SUPABASE_PROJECT_REF")
    use_psql = bool(url) and shutil.which("psql")

    if not use_psql and not ref:
        sys.exit(
            "Nothing to connect to. Set DATABASE_URL (with psql installed) for a local or "
            "CI Postgres, or SUPABASE_PROJECT_REF for the hosted project."
        )

    token = None if use_psql else access_token()
    route = "psql" if use_psql else f"management API, project {ref}"
    if not args.quiet:
        print(f"route: {route}", file=sys.stderr)

    failed = False
    for path in args.files:
        name = os.path.basename(path)
        if use_psql:
            code, out = run_psql(url, path)
        else:
            sql = META.sub(lambda m: "-- " + m.group(0).lstrip(), open(path).read())
            code, out = run_api(ref, sql, token)

        if code == 0:
            if not args.quiet:
                print(f"OK   {name}")
                if out.strip():
                    print("     " + out.strip().replace("\n", "\n     "))
        else:
            failed = True
            print(f"FAIL {name}", file=sys.stderr)
            print("     " + out.strip().replace("\n", "\n     "), file=sys.stderr)
            if not args.expect_failure:
                break

    if args.expect_failure:
        if failed:
            print("expected failure, and it failed")
            return 0
        print("expected this to fail, and it passed", file=sys.stderr)
        return 1

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
