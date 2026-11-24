#!/usr/bin/env python3
"""Upload a file to GitHub Releases via the proxy upload endpoint."""

import json
import mimetypes
import os
import re
import sys
import urllib.request

LEGACY_UPLOAD_URL = "http://proxy:8446/upload"
# The supervisor substitutes this placeholder for the real minted credential.
PLACEHOLDER = re.compile(r"openshell:resolve:env:[A-Za-z0-9_]+")

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"}


def upload_target():
    """Return (url, authorization) for the current execution mode.

    Legacy deployments keep the unauthenticated in-cluster default. Inside a
    dispatcher sandbox the dispatcher sets the authenticated gateway URL, and
    the only credential is the supervisor-issued placeholder.
    """
    url = os.environ.get("GH_RELEASE_UPLOAD_URL", "").strip()
    if os.environ.get("REHOR_INPUT_SOURCE") != "sandbox":
        return url or LEGACY_UPLOAD_URL, None
    if not url:
        # Never fall back to the legacy proxy host from a sandbox.
        raise RuntimeError("GH_RELEASE_UPLOAD_URL is required in the sandbox")
    for name in ("EXECUTOR_TOKEN", "BOT_MEMORY_TOKEN"):
        token = os.environ.get(name, "")
        if PLACEHOLDER.fullmatch(token):
            return url, f"Bearer {token}"
    raise RuntimeError("sandbox upload credential placeholder unavailable")


def main():
    if len(sys.argv) < 3:
        print("Usage: upload.py <file_path> <owner/repo> [filename]")
        sys.exit(1)

    file_path = sys.argv[1]
    repo = sys.argv[2]
    filename = sys.argv[3] if len(sys.argv) > 3 else os.path.basename(file_path)

    try:
        upload_url, authorization = upload_target()
    except RuntimeError as error:
        print(f"ERR: {error}", file=sys.stderr)
        sys.exit(1)

    content_type, _ = mimetypes.guess_type(filename)
    if not content_type:
        content_type = "application/octet-stream"

    with open(file_path, "rb") as f:
        data = f.read()

    headers = {
        "Content-Type": content_type,
        "X-Repo": repo,
        "X-Filename": filename,
    }
    if authorization:
        headers["Authorization"] = authorization

    req = urllib.request.Request(
        upload_url,
        data=data,
        headers=headers,
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            result = json.loads(resp.read())
            url = result["url"]
            ext = os.path.splitext(filename)[1].lower()
            if ext in IMAGE_EXTENSIONS:
                print(f"![{filename}]({url})")
            else:
                print(f"[{filename}]({url})")
    except urllib.error.HTTPError as e:
        body = e.read().decode() if e.fp else ""
        print(f"ERR: {e.code} {body[:200]}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
