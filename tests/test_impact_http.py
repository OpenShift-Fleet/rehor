import importlib.util
import json
import threading
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

MODULE_PATH = Path(__file__).parents[1] / "impact-data" / "collect_rehor_impact.py"
SPEC = importlib.util.spec_from_file_location("collect_rehor_impact", MODULE_PATH)
collect_rehor_impact = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(collect_rehor_impact)


class CaptureHandler(BaseHTTPRequestHandler):
    authorization = None

    def do_GET(self):
        type(self).authorization = self.headers.get("Authorization")
        body = json.dumps({}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        pass


def test_memory_bearer_token_is_not_forwarded_across_redirect():
    destination = ThreadingHTTPServer(("127.0.0.1", 0), CaptureHandler)
    destination_thread = threading.Thread(target=destination.serve_forever)
    destination_thread.start()

    class RedirectHandler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(302)
            self.send_header("Location", f"http://127.0.0.1:{destination.server_port}/target")
            self.end_headers()

        def log_message(self, format, *args):
            pass

    redirect = ThreadingHTTPServer(("127.0.0.1", 0), RedirectHandler)
    redirect_thread = threading.Thread(target=redirect.serve_forever)
    redirect_thread.start()

    try:
        client = collect_rehor_impact.HttpClient(
            f"http://127.0.0.1:{redirect.server_port}",
            {"Authorization": "Bearer test-token"},
        )
        with pytest.raises(urllib.error.HTTPError):
            client.get("redirect")
        assert CaptureHandler.authorization is None
    finally:
        redirect.shutdown()
        destination.shutdown()
        redirect_thread.join()
        destination_thread.join()
