"""Run the canonical Slack helper with an in-process MCP argument capture, not transport."""

import contextlib
import io
import json
import runpy
import sys
import types

helper = sys.argv[1]
calls = []
cleanups = []
memory = types.ModuleType("memory_mcp")


def memory_call(name, arguments):
    calls.append({"name": name, "arguments": arguments})
    return {"sent": True, "fixture": "MCP argument capture only"}


memory.__dict__.update(memory_call=memory_call, memory_cleanup=lambda: cleanups.append(True))
sys.modules["memory_mcp"] = memory
sys.argv = [helper, "SYNTHETIC-199", "pr_created", "Synthetic notification"]
output = io.StringIO()
with contextlib.redirect_stdout(output):
    runpy.run_path(helper, run_name="__main__")
print(json.dumps({"calls": calls, "cleanups": len(cleanups), "result": json.loads(output.getvalue())}))
