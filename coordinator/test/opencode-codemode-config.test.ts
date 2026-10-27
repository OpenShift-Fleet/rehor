import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { PythonCoordinatorBridge } from "../src/bridges/python";
import type { McpServerConfig } from "../src/ports/runtime-config";
import {
  renderOpenCodeConfig,
  renderOpenCodeConfigForCycle,
} from "../src/runtimes/opencode/render";
import type { JsonObject, OpenCodePermissionRule } from "../src/runtimes/opencode/types";

const executeAllowed = (permissions: unknown) =>
  (permissions as OpenCodePermissionRule[]).some(
    (rule) => rule.action === "execute" && rule.effect === "allow",
  );

it.each([undefined, true, false])(
  "preserves generated local/remote codemode %s and grants the required wrapper only",
  (codemode) => {
    for (const transport of [
      { command: "fixture" },
      { type: "http", url: "http://127.0.0.1:8080/mcp" },
      { type: "sse", url: "http://127.0.0.1:8080/mcp" },
    ] as McpServerConfig[]) {
      const rendered = renderOpenCodeConfig({
        model: "p/m",
        allowedTools: ["mcp__fixture__search"],
        mcpServers: { fixture: { ...transport, ...(codemode === undefined ? {} : { codemode }) } },
      });
      const server = ((rendered.config.mcp as JsonObject).servers as JsonObject)
        .fixture as JsonObject;
      expect(Object.hasOwn(server, "codemode")).toBe(codemode !== undefined);
      expect(server.codemode).toBe(codemode);
      expect(executeAllowed(rendered.config.permissions)).toBe(codemode !== false);
      expect(executeAllowed(JSON.parse(rendered.enforcementJson).permissions)).toBe(
        codemode !== false,
      );
    }
  },
);

it.each([undefined, true, false])(
  "accepts profile codemode %s without replacing the native default",
  (codemode) => {
    const server = {
      type: "remote",
      url: "https://example.invalid/mcp",
      ...(codemode === undefined ? {} : { codemode }),
    };
    const rendered = renderOpenCodeConfigForCycle(
      { model: "m" },
      "p",
      {},
      { settings: { mcp: { servers: { profile: server } } }, files: [] },
    );
    expect(rendered.profileConfig.mcp).toEqual({ servers: { profile: server } });
    expect(JSON.parse(rendered.enforcementJson).mcp.servers.profile).toEqual(server);
  },
);

it("derives wrapper permission from the granted active server, not unrelated Code Mode servers", () => {
  const servers: Record<string, McpServerConfig> = {
    direct: { command: "fixture", codemode: false },
    wrapped: { command: "fixture" },
    disabled: { command: "fixture", codemode: true, alwaysLoad: false },
  };
  const render = (allowedTools: string[]) =>
    renderOpenCodeConfig({
      model: "p/m",
      allowedTools,
      mcpServers: servers,
      optionalMcpServers: ["missing"],
    });
  expect(executeAllowed(render([]).config.permissions)).toBe(false);
  expect(executeAllowed(render(["mcp__direct__search"]).config.permissions)).toBe(false);
  expect(executeAllowed(render(["mcp__disabled__search"]).config.permissions)).toBe(false);
  expect(executeAllowed(render(["mcp__missing__search"]).config.permissions)).toBe(false);
  expect(executeAllowed(render(["mcp__wrapped__search"]).config.permissions)).toBe(true);
  expect(executeAllowed(render(["mcp__direct__search", "execute"]).config.permissions)).toBe(true);
});

it.each(["true", 1, null])(
  "rejects non-boolean codemode %j in generated and profile settings",
  (codemode) => {
    expect(() =>
      renderOpenCodeConfig({
        model: "p/m",
        mcpServers: { bad: { command: "fixture", codemode } as unknown as McpServerConfig },
      }),
    ).toThrow("codemode must be boolean");
    expect(() =>
      renderOpenCodeConfigForCycle(
        { model: "m" },
        "p",
        {},
        {
          settings: {
            mcp: { servers: { bad: { type: "local", command: ["fixture"], codemode } } },
          },
          files: [],
        },
      ),
    ).toThrow("codemode must be boolean");
  },
);

it("propagates optional central MCP settings through the actual bridge decoder into native config", async () => {
  const root = await mkdtemp(join(tmpdir(), "codemode-bridge-"));
  try {
    await mkdir(join(root, "bot"));
    await writeFile(join(root, "bot/__init__.py"), "");
    await writeFile(
      join(root, "bot/coordinator_bridge.py"),
      'import json, pathlib, sys\nassert json.loads(sys.stdin.readline())["operation"] == "prepare"\nprint(json.dumps({"protocolVersion": 1, "ok": True, "result": json.loads(pathlib.Path("fixture.json").read_text())}))\n',
    );
    const servers = {
      localDirect: { command: "fixture", codemode: false },
      localWrapped: { command: "fixture", codemode: true },
      localDefault: { command: "fixture" },
      remoteDirect: { type: "http", url: "http://127.0.0.1:8080/mcp", codemode: false },
      remoteWrapped: { type: "sse", url: "http://127.0.0.1:8080/mcp", codemode: true },
      remoteDefault: { type: "http", url: "http://127.0.0.1:8080/mcp" },
    };
    const prepared = {
      model: "m",
      runtimeId: "opencode",
      providerId: "p",
      maxTurns: 10,
      intervalSeconds: 60,
      idleIntervalSeconds: 60,
      cycleTimeoutSeconds: 1800,
      idleReminderCooldownSeconds: 3600,
      workflow: "onboarding",
      source: "test",
      envs: [],
      activeEnvs: [],
      claudeMdStrategy: "ignore",
      idleCycleLimit: 0,
      remoteAgentDir: null,
      sharedAgentDir: null,
      claudeMdPath: join(root, "CLAUDE.md"),
      mcpServers: servers,
      openCodeMcpServers: servers,
      allowedTools: ["mcp__localDirect__search"],
      optionalMcpServers: [],
    };
    await writeFile(join(root, "fixture.json"), JSON.stringify(prepared));
    const bridge = new PythonCoordinatorBridge({ cwd: root });
    const signal = AbortSignal.timeout(15000);
    const parsed = await bridge.prepareConfig({ scriptDir: root, label: "test" }, signal);
    expect(parsed.mcpServers).toEqual(servers);
    expect(parsed.openCodeMcpServers).toEqual(servers);
    const native = renderOpenCodeConfigForCycle(parsed, "p");
    const output = (native.config.mcp as JsonObject).servers as JsonObject;
    expect((output.localDirect as JsonObject).codemode).toBe(false);
    expect((output.remoteWrapped as JsonObject).codemode).toBe(true);
    expect(output.localDefault).not.toHaveProperty("codemode");
    expect(output.remoteDefault).not.toHaveProperty("codemode");
    expect(executeAllowed(native.config.permissions)).toBe(false);
    await writeFile(
      join(root, "fixture.json"),
      JSON.stringify({
        ...prepared,
        openCodeMcpServers: { bad: { command: "fixture", codemode: "true" } },
      }),
    );
    await expect(bridge.prepareConfig({ scriptDir: root, label: "test" }, signal)).rejects.toThrow(
      "codemode must be a boolean",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
