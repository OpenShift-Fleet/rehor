import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  renderOpenCodeConfig,
  renderOpenCodeConfigForCycle,
  writeOpenCodeConfig,
} from "../src/runtimes/opencode/render";
import type {
  OpenCodeConfigInput,
  OpenCodeDeploymentConfig,
  OpenCodePermissionRule,
} from "../src/runtimes/opencode/types";

const input: OpenCodeConfigInput = {
  model: "rehor-openai/model",
  smallModel: "rehor-openai/title",
  providers: [
    {
      id: "rehor-openai",
      package: "@opencode/ai/providers/openai/responses",
      settings: {
        baseURL: "{env:REHOR_MODEL_PROXY_URL}",
        apiKey: "{env:REHOR_MODEL_PROXY_TOKEN}",
      },
      models: {
        model: {
          modelID: "upstream",
          capabilities: { tools: true, reasoning: { supported: true } },
          limit: { context: 128000, output: 16000 },
        },
      },
    },
  ],
  allowedTools: ["Read", "Edit", "Bash(git *)", "Task", "mcp__jira.cloud__issue.search"],
  mcpServers: { "jira.cloud": { type: "http", url: "{env:JIRA_MCP_URL}", timeout: 30000 } },
  additionalDirectories: ["/approved"],
};
const rules = (value: unknown) => value as OpenCodePermissionRule[];

describe("native OpenCode V2 config", () => {
  it("renders native providers, title agent, ordered permissions and MCP timeouts", () => {
    const rendered = renderOpenCodeConfig(input);
    expect(rendered.config).toMatchObject({
      update: "disable",
      agents: { title: { model: "rehor-openai/title" } },
      providers: {
        "rehor-openai": {
          package: "@opencode/ai/providers/openai/responses",
          settings: input.providers?.[0].settings,
          models: input.providers?.[0].models,
        },
      },
      mcp: {
        servers: {
          "jira.cloud": {
            type: "remote",
            disabled: false,
            timeout: { startup: 30000, catalog: 30000, execution: 30000 },
          },
        },
      },
    });
    expect(rules(rendered.config.permissions)).toContainEqual({
      action: "shell",
      resource: "git *",
      effect: "allow",
    });
    expect(rules(rendered.config.permissions)).toContainEqual({
      action: "subagent",
      resource: "*",
      effect: "allow",
    });
    expect(rules(rendered.config.permissions)).toContainEqual({
      action: "execute",
      resource: "*",
      effect: "allow",
    });
    const permission = rules(rendered.config.permissions);
    expect(permission.findIndex((rule) => rule.action === "jira_cloud_*")).toBeLessThan(
      permission.findIndex((rule) => rule.action === "jira_cloud_issue_search"),
    );
    for (const key of [
      "provider",
      "agent",
      "command",
      "plugin",
      "permission",
      "small_model",
      "enabled_providers",
      "disabled_providers",
      "autoupdate",
      "lsp",
    ])
      expect(rendered.config).not.toHaveProperty(key);
    expect(rendered.requiredEnvironment).toEqual([
      "REHOR_MODEL_PROXY_TOKEN",
      "REHOR_MODEL_PROXY_URL",
    ]);
    expect(rendered.config.policies).toContainEqual({
      action: "provider.use",
      resource: "*",
      effect: "deny",
    });
  });

  it("matches native deployment snapshots and identical default/example inputs", async () => {
    const configs = await Promise.all(
      ["default", "example"].map(
        async (name) =>
          JSON.parse(
            await readFile(new URL(`../opencode-deployment.${name}.json`, import.meta.url), "utf8"),
          ) as OpenCodeDeploymentConfig,
      ),
    );
    expect(configs[0]).toEqual(configs[1]);
    const rendered = renderOpenCodeConfigForCycle(
      { model: "gpt-6-luna", allowedTools: ["Read"] },
      "rehor-openai",
      configs[0],
    );
    const config = JSON.parse(rendered.json);
    config.providers.vertex.package = "aisdk:<coordinator-vertex-provider>";
    expect({ config, packageLock: rendered.packageLock }).toMatchSnapshot();
  });

  it("stages native global policies and separate profile without compatibility fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-config-"));
    try {
      const rendered = renderOpenCodeConfig(input);
      const files = await writeOpenCodeConfig(root, rendered);
      expect(await readFile(files.globalConfigPath, "utf8")).toBe(rendered.json);
      expect(JSON.parse(await readFile(files.configPath, "utf8"))).toEqual({
        $schema: "https://opencode.ai/config.json",
      });
      expect(JSON.parse(rendered.enforcementJson).permissions).toEqual(rendered.config.permissions);
      expect(JSON.parse(rendered.enforcementJson)).not.toHaveProperty("policies");
      expect(JSON.parse(rendered.enforcementJson).plugins).toEqual([
        "-opencode.tools",
        "-opencode.tools.mcp-resources",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires exact-pinned external aisdk packages and plugin objects", () => {
    const rendered = renderOpenCodeConfig({
      model: "custom/model",
      providers: [{ id: "custom", package: "aisdk:custom-provider" }],
      packages: [{ name: "custom-provider", version: "1.2.3" }],
      plugins: [
        {
          name: "review-plugin",
          version: "2.3.4",
          options: { endpoint: "{env:REHOR_MODEL_PROXY_URL}" },
        },
      ],
    });
    expect(rendered.config.providers).toMatchObject({
      custom: { package: "aisdk:custom-provider@1.2.3" },
    });
    expect(rendered.config.plugins).toContainEqual({
      package: "review-plugin@2.3.4",
      options: { endpoint: "{env:REHOR_MODEL_PROXY_URL}" },
    });
    expect(() =>
      renderOpenCodeConfig({
        model: "custom/model",
        providers: [{ id: "custom", package: "aisdk:custom-provider" }],
      }),
    ).toThrow("not declared");
    expect(() =>
      renderOpenCodeConfig({
        model: "custom/model",
        providers: [{ id: "custom", package: "aisdk:custom-provider@1.2.3" }],
        packages: [{ name: "custom-provider", version: "4.5.6" }],
      }),
    ).toThrow("conflicting");
  });

  it.each([
    "@ai-sdk/openai",
    "@ai-sdk/openai-compatible",
    "npm:@ai-sdk/openai",
    "@opencode/ai/providers/openai@2.1.2",
  ])("rejects non-native or versioned builtin package %s", (packageName) => {
    expect(() =>
      renderOpenCodeConfig({
        model: "custom/model",
        providers: [{ id: "custom", package: packageName }],
      }),
    ).toThrow("native runtime or aisdk:");
  });

  it("keeps custom Vertex proxy module in native aisdk bridge and selects allowed title model", () => {
    const rendered = renderOpenCodeConfigForCycle(
      { model: "claude-opus-4-6" },
      "vertex",
      {
        providers: [
          {
            id: "vertex",
            settings: { baseURL: "{env:REHOR_VERTEX_PROXY_URL}" },
            models: { "claude-sonnet-4-6": {} },
          },
        ],
      },
      undefined,
      ["claude-sonnet-4-6"],
    );
    expect(rendered.config.providers).toMatchObject({
      vertex: { package: expect.stringMatching(/^aisdk:file:.*vertex-provider\.js$/) },
    });
    expect(rendered.config.agents).toEqual({ title: { model: "vertex/claude-sonnet-4-6" } });
    expect(rendered.requiredEnvironment).toEqual(["REHOR_VERTEX_PROXY_URL"]);
  });

  it("keeps default denies and enables todos/execute only when intended", () => {
    const config = renderOpenCodeConfig({ model: "p/m" }).config;
    expect(rules(config.permissions)[0]).toEqual({ action: "*", resource: "*", effect: "deny" });
    expect(rules(config.permissions)).not.toContainEqual({
      action: "execute",
      resource: "*",
      effect: "allow",
    });
    expect(config.experimental).toBeUndefined();
    expect(
      rules(renderOpenCodeConfig({ model: "p/m", allowedTools: ["execute"] }).config.permissions),
    ).toContainEqual({ action: "execute", resource: "*", effect: "allow" });
    expect(
      renderOpenCodeConfig({ model: "p/m", allowedTools: ["TodoWrite"] }).config.experimental,
    ).toEqual({ todo: true });
  });

  it.each([
    null,
    "/tmp",
    ["/"],
    ["relative"],
    ["~/repos"],
    ["/tmp/../repos"],
    ["/tmp/*"],
    ["/tmp/?"],
    ["/tmp/[abc]"],
    ["/tmp/{env:HOME}"],
    ["/tmp/\\repos"],
    ["/tmp/repos\n"],
    ["/tmp/ repos"],
    ["/tmp/repos/"],
  ])("rejects malformed deployment roots %j", (additionalDirectories) => {
    expect(() =>
      renderOpenCodeConfig({ model: "p/m", additionalDirectories } as OpenCodeConfigInput),
    ).toThrow("additionalDirectories");
  });

  it.each([
    "GH_TOKEN",
    "OPENAI_API_KEY",
    "JIRA_USERNAME",
    "AWS_SECRET_ACCESS_KEY",
    "OPENCODE_CONFIG",
  ])("blocks unapproved provider references %s", (name) => {
    expect(() =>
      renderOpenCodeConfig({
        model: "p/m",
        providers: [{ id: "p", settings: { apiKey: `{env:${name}}` } }],
      }),
    ).toThrow();
  });

  it("rejects literal credentials and arbitrary MCP references", () => {
    expect(() =>
      renderOpenCodeConfig({ model: "p/m", providers: [{ id: "p", name: "{env:GH_TOKEN}" }] }),
    ).toThrow();
    expect(() =>
      renderOpenCodeConfig({
        model: "p/m",
        providers: [{ id: "p", settings: { apiKey: "literal-secret" } }],
      }),
    ).toThrow("environment reference");
    expect(() =>
      renderOpenCodeConfig({
        model: "p/m",
        mcpServers: { jira: { type: "http", url: "https://example/{env:GH_TOKEN}" } },
      }),
    ).toThrow("unapproved");
    expect(() =>
      renderOpenCodeConfig({
        model: "p/m",
        mcpServers: {
          jira: {
            type: "http",
            url: "https://example",
            headers: { Authorization: "{env:JIRA_MCP_URL}" },
          },
        },
      }),
    ).toThrow("cannot reference");
  });

  it("rejects normalized MCP collisions and missing non-optional grants", () => {
    expect(() =>
      renderOpenCodeConfig({
        model: "p/m",
        mcpServers: { "jira.cloud": { command: "one" }, jira_cloud: { command: "two" } },
      }),
    ).toThrow("namespace");
    expect(() =>
      renderOpenCodeConfig({
        model: "p/m",
        mcpServers: { jira: { command: "jira" } },
        allowedTools: ["mcp__jira__issue.search", "mcp__jira__issue_search"],
      }),
    ).toThrow("permission key");
    expect(() =>
      renderOpenCodeConfig({ model: "p/m", allowedTools: ["mcp__missing__search"] }),
    ).toThrow("unconfigured");
    expect(() =>
      renderOpenCodeConfig({
        model: "p/m",
        allowedTools: ["mcp__optional__search"],
        optionalMcpServers: ["optional"],
      }),
    ).not.toThrow();
  });

  it.each([
    { provider: { id: "p" } },
    { packageLock: {} },
    { providers: [{ id: "p", npm: "@ai-sdk/openai" }] },
    { providers: [{ id: "p", options: {} }] },
    { providers: [{ id: "p", models: { m: { reasoning: true } } }] },
  ])("rejects deployment legacy fields %j", (legacy) => {
    expect(() =>
      renderOpenCodeConfig({ model: "p/m", ...legacy } as unknown as OpenCodeConfigInput),
    ).toThrow("legacy");
  });
});
