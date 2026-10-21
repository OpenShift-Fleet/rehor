#!/usr/bin/env python3
"""Export a small pricing registry from a pinned OpenCode binary, without inference.

Usage: python3 scripts/opencode-pricing.py /path/to/opencode > /tmp/pricing.json
Review the output before replacing src/runtimes/opencode/pricing.json.
"""

import hashlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

VERSION = "1.18.35"
MODELS = {
    "openai": [
        "gpt-4.1",
        "gpt-4.1-mini",
        "gpt-4o",
        "gpt-4o-mini",
        "gpt-5",
        "gpt-5-mini",
        "gpt-5-nano",
        "gpt-5.6-luna",
        "gpt-5.6-sol",
        "gpt-6-luna",
        "gpt-6.1-sol",
    ],
    "google-vertex-anthropic": [
        "claude-haiku-4-5@20251001",
        "claude-opus-4-6@default",
        "claude-sonnet-4-6@default",
    ],
}


def main():
    binary = Path(sys.argv[1]).resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix="opencode-pricing-") as home:
        env = {
            "PATH": os.defpath,
            "HOME": home,
            "XDG_CONFIG_HOME": f"{home}/config",
            "XDG_CACHE_HOME": f"{home}/cache",
            "XDG_DATA_HOME": f"{home}/data",
            "XDG_STATE_HOME": f"{home}/state",
            "OPENCODE_TEST_HOME": home,
            "OPENCODE_AUTH_CONTENT": "{}",
            "OPENCODE_PURE": "1",
            "OPENCODE_DISABLE_PROJECT_CONFIG": "1",
            "OPENCODE_DISABLE_MODELS_FETCH": "1",
            "OPENCODE_DISABLE_AUTOUPDATE": "1",
            "OPENCODE_CONFIG_CONTENT": json.dumps(
                {
                    "enabled_providers": list(MODELS),
                    # No model declarations: V1 model overlays discard native tiers.
                    "provider": {provider: {} for provider in MODELS},
                }
            ),
        }

        def run(*args):
            return subprocess.check_output([str(binary), *args], env=env, cwd=home, text=True)

        if run("--version").strip() != VERSION:
            raise SystemExit(f"Expected OpenCode {VERSION}")
        text = run("models", "--verbose", "--pure")
    decoder = json.JSONDecoder()
    models = {}
    while text.strip():
        key, text = text.lstrip().split("\n", 1)
        model, end = decoder.raw_decode(text)
        text = text[end:]
        provider, model_id = key.split("/", 1)
        if model_id in MODELS.get(provider, []):
            models[key] = model["cost"]
    expected = {f"{p}/{m}" for p, ids in MODELS.items() for m in ids}
    if models.keys() != expected:
        raise SystemExit(f"Missing models: {sorted(expected - models.keys())}")
    models = dict(sorted(models.items()))
    canonical = json.dumps(models, sort_keys=True, separators=(",", ":")).encode()
    print(
        json.dumps(
            {
                "source": {
                    "name": "OpenCode baked models.dev catalog",
                    "version": VERSION,
                    "binarySha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
                    "pricingSha256": hashlib.sha256(canonical).hexdigest(),
                    "upstream": f"https://github.com/anomalyco/opencode/tree/v{VERSION}",
                    "command": "models --verbose --pure (isolated HOME/XDG; model fetch disabled)",
                    "units": "USD per million tokens",
                },
                "models": models,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
