---
name: gh-release-upload
description: >
  Upload a file to GitHub Releases via the proxy's upload endpoint.
  Returns a stable download URL. Use instead of `gh release upload` which fails
  through the thin client.
when_to_use: >
  Invoke when the bot needs to upload any file to GitHub Releases — screenshots,
  test reports, build artifacts, etc. Triggers on: "upload screenshot", "upload file",
  "attach image", "gh release upload", "release asset".
user-invocable: true
allowed-tools:
  - "Bash(python3 .claude/skills/gh-release-upload/upload.py *)"
  - Read
---

Upload a file to GitHub Releases:

```bash
python3 .claude/skills/gh-release-upload/upload.py <file_path> <owner/repo> [filename]
```

Arguments:
- `file_path`: Path to the file to upload
- `owner/repo`: GitHub repository (e.g. `RedHatInsights/insights-chrome`)
- `filename` (optional): Override the asset filename. Defaults to the file's basename.

Returns a markdown link: `![filename](url)` for images, `[filename](url)` for other files.
