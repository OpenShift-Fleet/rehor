#!/usr/bin/env python3
"""Upload a file to GitHub Releases via the proxy upload endpoint."""

import json
import mimetypes
import os
import sys
import urllib.request

UPLOAD_URL = os.environ.get("GH_RELEASE_UPLOAD_URL", "http://proxy:8446/upload")

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"}


def main():
    if len(sys.argv) < 3:
        print("Usage: upload.py <file_path> <owner/repo> [filename]")
        sys.exit(1)

    file_path = sys.argv[1]
    repo = sys.argv[2]
    filename = sys.argv[3] if len(sys.argv) > 3 else os.path.basename(file_path)

    content_type, _ = mimetypes.guess_type(filename)
    if not content_type:
        content_type = "application/octet-stream"

    with open(file_path, "rb") as f:
        data = f.read()

    req = urllib.request.Request(
        UPLOAD_URL,
        data=data,
        headers={
            "Content-Type": content_type,
            "X-Repo": repo,
            "X-Filename": filename,
        },
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
