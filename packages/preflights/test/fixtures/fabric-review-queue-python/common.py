"""Test scaffolding: the `common` preflight helpers review_queue.py imports.

The real module lives in the Fabric `dev-bot` submodule (rehor pin) and only
provides process-level wiring (instance identity, memory URL, HTTP fetch,
project-repos loading, result output). run_queue.py patches every one of
these names on the imported module before main() runs, so the stub never
executes real logic.
"""

INSTANCE_ID = "reviewer"
MEMORY_URL = "https://memory.invalid"


def http_get(url):
    raise RuntimeError("patched in run_queue.py")


def load_project_repos():
    raise RuntimeError("patched in run_queue.py")


def output_result(status, content):
    raise RuntimeError("patched in run_queue.py")
