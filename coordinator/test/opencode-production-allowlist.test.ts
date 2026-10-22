import { expect, it } from "vitest";
import { renderOpenCodeConfigForCycle } from "../src/runtimes/opencode/render";
import type { OpenCodePermissionRule } from "../src/runtimes/opencode/types";
import { prepareProductionAllowlist } from "./fixtures/production-allowlist";

it.each([false, true])(
  "renders actual Python production allowlist through prepare with optional envs %s",
  (optionalEnvs) => {
    const { result, sharedAllowedTools, diagnostic } = prepareProductionAllowlist(optionalEnvs);
    expect(sharedAllowedTools).toContain("LSP");
    expect(result.allowedTools).toEqual(sharedAllowedTools.filter((tool) => tool !== "LSP"));
    expect(diagnostic).toContain("OpenCode V2.1.2 does not support LSP");
    expect(result.optionalMcpServers).toEqual(
      expect.arrayContaining(["chrome-devtools", "hcc-patternfly-data-view"]),
    );
    expect(Object.hasOwn(result.openCodeMcpServers, "chrome-devtools")).toBe(optionalEnvs);
    expect(Object.hasOwn(result.openCodeMcpServers, "hcc-patternfly-data-view")).toBe(optionalEnvs);
    const rendered = renderOpenCodeConfigForCycle(result, result.providerId);
    const permissions = rendered.config.permissions as unknown as OpenCodePermissionRule[];
    expect(permissions[0]).toEqual({ action: "*", resource: "*", effect: "deny" });
    for (const action of ["edit", "read", "glob", "grep", "shell", "skill", "execute"])
      expect(permissions).toContainEqual({ action, resource: "*", effect: "allow" });
    expect(permissions).toContainEqual({
      action: "mcp-atlassian_jira_search",
      resource: "*",
      effect: "allow",
    });
    expect(permissions).toContainEqual({ action: "bot-memory_*", resource: "*", effect: "allow" });
    for (const action of ["chrome-devtools_*", "hcc-patternfly-data-view_*"])
      expect(permissions.some((rule) => rule.action === action && rule.effect === "allow")).toBe(
        optionalEnvs,
      );
    expect(permissions.some((rule) => /lsp/i.test(rule.action))).toBe(false);
    expect(rendered.config).not.toHaveProperty("lsp");
    expect(rendered.config.plugins).not.toContain("-*");
    expect(() =>
      renderOpenCodeConfigForCycle(
        { ...result, allowedTools: [...(result.allowedTools ?? []), "UnknownFutureTool"] },
        result.providerId,
      ),
    ).toThrow("allowed tool 'UnknownFutureTool'");
    expect(() =>
      renderOpenCodeConfigForCycle(
        { ...result, allowedTools: sharedAllowedTools },
        result.providerId,
      ),
    ).toThrow("allowed tool 'LSP'");
  },
);
