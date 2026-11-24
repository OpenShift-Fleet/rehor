#!/bin/bash
# Controlled, offline image smoke: no preflight, credentials, or agent session.
set -euo pipefail
image="${1:?usage: verify-private-runtime.sh IMAGE}"
runtime="${RUNTIME:-docker}"

for engine in python coordinator; do
    if output=$("$runtime" run --rm --network none --user 1001080000:1001080000 --workdir /tmp \
        -e REHOR_INPUT_SOURCE=sandbox -e REHOR_INPUT_FILE=/tmp/rehor-input.json \
        -e BOT_LABEL=test -e BOT_INSTANCE_ID=test -e "BOT_EXECUTION_ENGINE=$engine" \
        -e REHOR_WORKSPACE_OWNER_UID=1000 --entrypoint /bin/bash "$image" -c '
        umask 077
        printf '\''{"schemaVersion":1,"runId":"00000000-0000-0000-0000-000000000001","prompt":"","metadata":{"action":"start","scripts":[]}}'\'' > /tmp/rehor-input.json
        exec /usr/bin/python3.12 /opt/rehor/sandbox-bootstrap.py
    ' 2>&1); then
        if [ "$engine" != coordinator ]; then
            echo "$engine: sandbox dispatch unexpectedly succeeded" >&2
            exit 1
        fi
        case "$output" in *"Sandbox input prompt is empty"*) ;; *) echo "$engine: expected empty-input skip" >&2; exit 1 ;; esac
    else
        if [ "$engine" != python ]; then
            echo "$engine: expected empty-input skip: $output" >&2
            exit 1
        fi
        case "$output" in *"sandbox dispatch requires BOT_EXECUTION_ENGINE=coordinator"*) ;; *) echo "$engine: expected engine rejection: $output" >&2; exit 1 ;; esac
    fi
done

"$runtime" run --rm --network none --user 1001080000:1001080000 --workdir /tmp \
    -e REHOR_INPUT_SOURCE=sandbox -e REHOR_WORKSPACE_OWNER_UID=1000 \
    --entrypoint /usr/bin/python3.12 "$image" -c '
import os, pathlib, runpy, stat
def check(*args):
    home = pathlib.Path(os.environ["HOME"])
    app = pathlib.Path.cwd()
    assert os.geteuid() == os.getegid() == 1001080000
    assert not os.access("/home/botuser/app", os.X_OK)
    assert os.environ["REHOR_WORKSPACE_OWNER_UID"] == str(os.geteuid())
    assert all(p.stat().st_uid == os.geteuid() and stat.S_IMODE(p.stat().st_mode) == 0o700 for p in (home.parent, home, app))
    assert (app / ".venv").is_symlink() and (app / "coordinator/node_modules").is_symlink()
    assert not os.access("/opt/rehor/app/config.json", os.W_OK)
    print("private runtime UID, ownership, mode and dependency links verified")
os.execv = check
runpy.run_path("/opt/rehor/sandbox-bootstrap.py", run_name="__main__")
'
echo "Coordinator empty-input skip and Python sandbox rejection passed without network or preflight"
