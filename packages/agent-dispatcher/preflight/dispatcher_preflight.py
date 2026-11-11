"""Private dispatcher subprocess bootstrap and memory authentication bridge."""

import importlib.util
import json
import os
import runpy
import sys
import urllib.error
import urllib.parse
import urllib.request


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _install_memory_auth(common):
    """Authenticate only the configured memory task endpoint, never redirects."""
    token = os.environ.get("BOT_MEMORY_TOKEN", "")
    if not token or not hasattr(common, "http_get") or not hasattr(common, "MEMORY_URL"):
        return
    # Older synced checkouts may still have their own token-reading hook.
    if hasattr(common, "_auth_headers"):
        common._auth_headers = lambda: {}
    original = common.http_get
    endpoint = urllib.parse.urlsplit(f"{common.MEMORY_URL}/api/tasks")

    def http_get(url, timeout=10):
        target = urllib.parse.urlsplit(url)
        if (
            endpoint.scheme not in ("http", "https")
            or not endpoint.hostname
            or endpoint.username is not None
            or endpoint.password is not None
            or (target.scheme, target.netloc, target.path) != (endpoint.scheme, endpoint.netloc, endpoint.path)
        ):
            return original(url, timeout=timeout)
        request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
        try:
            with urllib.request.build_opener(_NoRedirect()).open(request, timeout=timeout) as response:
                return json.loads(response.read())
        except urllib.error.HTTPError as error:
            if error.code in (401, 403):
                raise RuntimeError(f"authenticated request rejected ({error.code})") from error
            print(f"ERR GET {url}: {error}", file=sys.stderr)
            return None
        except Exception as error:
            print(f"ERR GET {url}: {error}", file=sys.stderr)
            return None

    common.http_get = http_get


def run(helper_dir, script):
    # Match Python's normal script-directory lookup, except dispatcher modules
    # intentionally take precedence over every checkout-provided module.
    sys.path[0:2] = [helper_dir, os.path.dirname(os.path.realpath(script))]
    sys.argv = [script]
    # Load by exact path, not merely by search order. A script may later add
    # checkout paths to sys.path, and a missing private helper must fail closed.
    spec = importlib.util.spec_from_file_location("jira_mcp", os.path.join(helper_dir, "jira_mcp.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    sys.modules["jira_mcp"] = module
    if os.environ.get("BOT_MEMORY_TOKEN") and importlib.util.find_spec("common") is not None:
        import common

        _install_memory_auth(common)
    runpy.run_path(script, run_name="__main__")
