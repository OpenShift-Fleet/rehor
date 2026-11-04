import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { renderOpenCodeConfigForCycle } from "../src/runtimes/opencode/render";
import type { OpenCodePermissionRule } from "../src/runtimes/opencode/types";
import { prepareProductionAllowlist } from "./fixtures/production-allowlist";

it("renders production grants and repository MCP through real prepare and validation without remote MCP or active envs", () => {
  const { result, sharedAllowedTools, diagnostic } = prepareProductionAllowlist();
  expect(sharedAllowedTools).toContain("LSP");
  expect(result.allowedTools).toEqual(sharedAllowedTools.filter((tool) => tool !== "LSP"));
  expect(diagnostic).toContain("OpenCode V2.1.2 does not support LSP");
  expect(result.optionalMcpServers).toEqual(
    expect.arrayContaining(["chrome-devtools", "hcc-patternfly-data-view"]),
  );
  expect(result.envs).toEqual([]);
  expect(result.activeEnvs).toEqual([]);
  const rootMcp = JSON.parse(readFileSync(new URL("../../.mcp.json", import.meta.url), "utf8"));
  const botMcp = JSON.parse(readFileSync(new URL("../../bot/mcp.json", import.meta.url), "utf8"));
  expect(result.openCodeMcpServers).toEqual({ ...botMcp.mcpServers, ...rootMcp.mcpServers });
  expect(result.openCodeMcpServers).toHaveProperty(
    "chrome-devtools",
    rootMcp.mcpServers["chrome-devtools"],
  );
  expect(result.openCodeMcpServers).not.toHaveProperty("hcc-patternfly-data-view");
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
  expect(permissions).toContainEqual({
    action: "chrome-devtools_*",
    resource: "*",
    effect: "allow",
  });
  expect(
    permissions.some(
      (rule) => rule.action === "hcc-patternfly-data-view_*" && rule.effect === "allow",
    ),
  ).toBe(false);
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
});
