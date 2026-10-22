import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ConfigPreparationResult } from "../../src/ports/python-bridge";

// Exercise the real Python prepare boundary and production grant/manifests.
// Stub the checkout/runtime shell module, not config or bridge preparation:
// coordinator CI intentionally installs only PyYAML, not bot.run dependencies.
// Deployment validation and checkout mutations are stubbed. Never load the
// developer's .env, merged deployment config, or credentials into this fixture.
const prepare = `
import json, shutil, sys, tempfile
from contextlib import ExitStack
from pathlib import Path
from types import ModuleType
from unittest.mock import patch
import yaml
import bot.coordinator_bridge as bridge
from bot.config import ALLOWED_TOOLS, discover_optional_mcp_servers

repo = Path.cwd()
enabled = sys.argv[1] == "enabled"
with tempfile.TemporaryDirectory(prefix="production-allowlist-") as temporary, ExitStack() as stack:
    root = Path(temporary)
    (root / "bot").mkdir()
    shutil.copyfile(repo / "bot/mcp.json", root / "bot/mcp.json")
    shutil.copyfile(repo / "config.json", root / "config.json")
    optional = set(discover_optional_mcp_servers(repo))
    project = json.loads((repo / ".mcp.json").read_text())
    project["mcpServers"] = {name: server for name, server in project["mcpServers"].items() if name not in optional}
    (root / ".mcp.json").write_text(json.dumps(project))
    merged = {}
    for manifest in (repo / "presets/envs").glob("*/manifest.yaml"):
        target = root / manifest.relative_to(repo)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(manifest, target)
        if enabled:
            merged.update((yaml.safe_load(manifest.read_text()) or {}).get("provides", {}).get("mcp_servers", {}))
    (root / "data").mkdir()
    (root / "data/merged-mcp.json").write_text(json.dumps({"mcpServers": merged}))
    profile = root / "profile"
    profile.mkdir()
    (profile / "instance.yaml").write_text("runtime: opencode\\nprovider: rehor-openai\\nmodel: fixture\\nworkflow: onboarding\\nenvs: " + ("[browser, patternfly-mcp]" if enabled else "[_none]") + "\\n")
    (root / "presets/workflows/onboarding").mkdir(parents=True)
    runner = ModuleType("bot.run")
    runner.SCRIPT_DIR = root
    runner.setup_git = lambda script_dir: None
    runner.sync_config_repo = lambda label: (profile, None)
    stack.enter_context(patch.dict(sys.modules, {"bot.run": runner}))
    stack.enter_context(patch("bot.merge.apply_merged_config"))
    stack.enter_context(patch("bot.merge.install_skills"))
    stack.enter_context(patch("bot.config.validate_instance_config"))
    stack.enter_context(patch("bot.config.validate_manifest"))
    stack.enter_context(patch.object(bridge, "_load_dotenv"))
    result = bridge.handle({"operation": "prepare", "scriptDir": str(root), "label": "fixture"})
    print(json.dumps({"result": result, "sharedAllowedTools": ALLOWED_TOOLS}))
`;

export function prepareProductionAllowlist(optionalEnvs = false): {
  result: ConfigPreparationResult;
  sharedAllowedTools: string[];
  diagnostic: string;
} {
  const child = spawnSync(
    process.env.PYTHON ?? "python3",
    ["-c", prepare, optionalEnvs ? "enabled" : "disabled"],
    {
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
      env: { PATH: process.env.PATH, HOME: process.env.HOME, PYTHONPATH: "." },
      encoding: "utf8",
      timeout: 30000,
    },
  );
  if (child.error || child.status !== 0)
    throw new Error(`Production Python prepare failed: ${child.error ?? child.stderr}`);
  return { ...JSON.parse(child.stdout), diagnostic: child.stderr };
}
