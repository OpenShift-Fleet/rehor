import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ConfigPreparationResult } from "../../src/ports/python-bridge";

// Exercise the real Python prepare boundary, validators, grants and MCP loading.
// Stub the checkout/runtime shell module, not config or bridge preparation:
// coordinator CI intentionally installs only PyYAML, not bot.run dependencies.
// Skill installation and dotenv loading are stubbed. Copy repository MCP files
// unchanged; no remote mcp.json means the real merge produces no merged MCP file.
// Env manifests identify optional grants, not server configuration. This fixture
// does not cover environment installation or remote MCP merging.
const prepare = `
import json, shutil, sys, tempfile
from contextlib import ExitStack
from pathlib import Path
from types import ModuleType
from unittest.mock import patch
import bot.coordinator_bridge as bridge
from bot.config import ALLOWED_TOOLS

repo = Path.cwd()
with tempfile.TemporaryDirectory(prefix="production-allowlist-") as temporary, ExitStack() as stack:
    root = Path(temporary)
    (root / "bot").mkdir()
    shutil.copyfile(repo / "bot/mcp.json", root / "bot/mcp.json")
    shutil.copyfile(repo / "config.json", root / "config.json")
    shutil.copyfile(repo / ".mcp.json", root / ".mcp.json")
    for manifest in (repo / "presets/envs").glob("*/manifest.yaml"):
        target = root / manifest.relative_to(repo)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(manifest, target)
    profile = root / "profile"
    profile.mkdir()
    (profile / "instance.yaml").write_text("runtime: opencode\\nprovider: rehor-openai\\nmodel: fixture\\nworkflow: onboarding\\nenvs: []\\n")
    workflow = root / "presets/workflows/onboarding"
    workflow.mkdir(parents=True)
    shutil.copyfile(repo / "presets/workflows/onboarding/manifest.yaml", workflow / "manifest.yaml")
    runner = ModuleType("bot.run")
    runner.SCRIPT_DIR = root
    runner.setup_git = lambda script_dir: None
    runner.sync_config_repo = lambda label: (profile, None)
    stack.enter_context(patch.dict(sys.modules, {"bot.run": runner}))
    stack.enter_context(patch("bot.merge.install_skills"))
    stack.enter_context(patch.object(bridge, "_load_dotenv"))
    result = bridge.handle({"operation": "prepare", "scriptDir": str(root), "label": "fixture"})
    assert not (root / "data/merged-mcp.json").exists()
    print(json.dumps({"result": result, "sharedAllowedTools": ALLOWED_TOOLS}))
`;

export function prepareProductionAllowlist(): {
  result: ConfigPreparationResult;
  sharedAllowedTools: string[];
  diagnostic: string;
} {
  const child = spawnSync(process.env.PYTHON ?? "python3", ["-c", prepare], {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      PYTHONPATH: ".",
      BOT_LABEL: "fixture",
      BOT_INSTANCE_ID: "fixture",
      BOT_JIRA_EMAIL: "fixture@example.invalid",
    },
    encoding: "utf8",
    timeout: 30000,
  });
  if (child.error || child.status !== 0)
    throw new Error(`Production Python prepare failed: ${child.error ?? child.stderr}`);
  return { ...JSON.parse(child.stdout), diagnostic: child.stderr };
}
