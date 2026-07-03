#!/bin/bash
# PatternFly MCP env preset — hcc-pf-mcp server for PatternFly component guidance
set -e

# Skip if already installed (idempotent during transition period)
if npm list -g @redhat-cloud-services/hcc-pf-mcp &>/dev/null 2>&1; then
    echo "patternfly-mcp preset: already installed, skipping"
    exit 0
fi

# Requires node preset (npm must be available)
if ! command -v npm &>/dev/null; then
    echo "ERROR: patternfly-mcp preset requires node preset (npm not found)" >&2
    exit 1
fi

npm install -g @redhat-cloud-services/hcc-pf-mcp
