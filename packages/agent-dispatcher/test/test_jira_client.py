"""Contract tests for the dispatcher-owned Python Jira bridge."""

import asyncio
import importlib.util
import io
import sys
import types
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from typing import ClassVar
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("dispatcher_jira", Path(__file__).parent.parent / "preflight/jira_mcp.py")
jira = importlib.util.module_from_spec(spec)
spec.loader.exec_module(jira)


class FakeSession:
    events: ClassVar[list] = []
    response = None

    def __init__(self, read, write):
        self.events.append("session-create")

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        self.events.append("session-close")

    async def initialize(self):
        self.events.append("initialize")

    async def call_tool(self, name, args):
        self.events.append((name, args))
        if self.response == "timeout":
            await asyncio.sleep(1)
        return self.response


class Transport:
    async def __aenter__(self):
        FakeSession.events.append("transport-open")
        return None, None, None

    async def __aexit__(self, *args):
        FakeSession.events.append("transport-close")


def response(text, is_error=False):
    return types.SimpleNamespace(isError=is_error, content=[types.SimpleNamespace(text=text)])


class JiraClientTest(unittest.TestCase):
    def setUp(self):
        FakeSession.events = []
        FakeSession.response = response('{"issues": []}')
        jira.JIRA_MCP_URL = "http://fixture.invalid/mcp"
        mcp = types.ModuleType("mcp")
        mcp.ClientSession = FakeSession
        client = types.ModuleType("mcp.client")
        stream = types.ModuleType("mcp.client.streamable_http")

        def connect(url):
            self.assertEqual(url, jira.JIRA_MCP_URL)
            return Transport()

        stream.streamablehttp_client = connect
        self.modules = patch.dict(sys.modules, {"mcp": mcp, "mcp.client": client, "mcp.client.streamable_http": stream})
        self.modules.start()

    def tearDown(self):
        jira.jira_cleanup()
        self.modules.stop()

    def test_session_handshake_reuse_and_cleanup(self):
        self.assertEqual(jira.jira_call("jira_search", {"jql": "test"}), {"issues": []})
        self.assertEqual(jira.jira_call("jira_get_issue", {"key": "TEST-1"}), {"issues": []})
        self.assertEqual(FakeSession.events.count("initialize"), 1)
        jira.jira_cleanup()
        self.assertEqual(FakeSession.events[-2:], ["session-close", "transport-close"])
        jira.jira_call("jira_search", {})
        self.assertEqual(FakeSession.events.count("initialize"), 2)

    def test_errors_timeout_invalid_json_and_missing_url_return_none(self):
        with redirect_stderr(io.StringIO()) as err:
            FakeSession.response = response("server error", is_error=True)
            self.assertIsNone(jira.jira_call("jira_search", {}))
            FakeSession.response = response("not json")
            self.assertIsNone(jira.jira_call("jira_search", {}))
            FakeSession.response = "timeout"
            self.assertIsNone(jira.jira_call("jira_search", {}, timeout=0.001))
            jira.JIRA_MCP_URL = ""
            self.assertIsNone(jira.jira_call("jira_search", {}))
        self.assertIn("server error", err.getvalue())
        self.assertIn("JIRA_MCP_URL not set", err.getvalue())


if __name__ == "__main__":
    unittest.main()
