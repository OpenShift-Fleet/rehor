#!/usr/bin/python3.12
"""Build the readable sandbox runtime from the customized legacy installation.

Run only during image construction, as root, after instance setup has finished.
"""

import os
import shutil
import stat
from pathlib import Path

source = Path("/home/botuser/app")
target = Path("/opt/rehor/app")
for directory, dirs, files in os.walk(source, followlinks=False):
    if Path(directory) == source:
        dirs[:] = [name for name in dirs if name not in {".venv", "data", "repos", ".git"}]
    if Path(directory) == source / "coordinator":
        dirs[:] = [name for name in dirs if name != "node_modules"]
    if {".env", ".credentials", ".netrc", ".npmrc", ".pypirc", ".git-credentials"}.intersection(files):
        raise SystemExit("Private runtime source contains a forbidden credential file")


def ignored(directory: str, names: list[str]) -> set[str]:
    if Path(directory) == source:
        return set(names).intersection({"data", "repos", ".git"})
    return set()


shutil.copytree(source, target, symlinks=True, ignore=ignored)
old = str(source).encode()
new = str(target).encode()
for path in (target / ".venv" / "bin").iterdir():
    if path.is_file() and not path.is_symlink():
        data = path.read_bytes()
        if b"\0" not in data and old in data:
            path.write_bytes(data.replace(old, new))
for path in (target / ".venv" / "lib").glob("python*/site-packages/*.pth"):
    if not path.is_symlink():
        data = path.read_bytes()
        if old in data:
            path.write_bytes(data.replace(old, new))

# The package is immutable to any non-root sandbox identity. It contains no
# runtime state; instance image authors must never bake credentials into it.
for directory, dirs, files in os.walk(target, followlinks=False):
    for name in [".", *dirs, *files]:
        path = Path(directory) / name
        if path.is_symlink():
            os.lchown(path, 0, 0)
            continue
        info = path.stat()
        os.chown(path, 0, 0)
        mode = stat.S_IMODE(info.st_mode)
        mode = (mode | stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH) & ~(
            stat.S_IWGRP | stat.S_IWOTH | stat.S_ISUID | stat.S_ISGID
        )
        if stat.S_ISDIR(info.st_mode):
            mode |= stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH
        elif mode & stat.S_IXUSR:
            mode |= stat.S_IXGRP | stat.S_IXOTH
        path.chmod(mode)
