import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { expect, it } from "vitest";
import { renderOpenCodeConfigForCycle, writeOpenCodeConfig } from "../src/runtimes/opencode/render";
import { prepareProductionAllowlist } from "./fixtures/production-allowlist";

// Pinned 2.1.2 snapshot: spawn the native server directly, without the production
// supervisor or real inference. FFF/native indexing and all MCP loading are
// excluded; Jira points at loopback port 1. Zero trap requests describe only
// this file-tool/LSP fixture, not deployed supervisor egress or download behavior.
// LSP canary is test-only; production renders no lsp field.
it.skipIf(!process.env.REHOR_TEST_OPENCODE_BINARY)(
  "snapshots OpenCode 2.1.2 TS/Python read/edit/write and inert LSP with FFF/MCP loading excluded",
  async () => {
    const binary = process.env.REHOR_TEST_OPENCODE_BINARY;
    if (!binary) throw new Error("REHOR_TEST_OPENCODE_BINARY required");
    expect(spawnSync(binary, ["--version"], { encoding: "utf8" }).stdout.trim()).toBe(
      "opencode v2.1.2",
    );
    const { result: preparation, diagnostic } = prepareProductionAllowlist();
    expect(diagnostic).toContain("does not support LSP");
    const root = await realpath(await mkdtemp(join(tmpdir(), "rehor-allowlist-native-")));
    const workspace = join(root, "workspace");
    const state = join(root, "state");
    const bin = join(root, "bin");
    const evidence = join(root, "unexpected-processes");
    for (const directory of [workspace, state, bin, evidence]) await mkdir(directory);
    const sentinel = join(bin, "lsp-canary");
    for (const command of [
      "lsp-canary",
      "typescript-language-server",
      "pyright-langserver",
      "basedpyright-langserver",
      "ty",
      "npm",
      "npx",
      "uv",
      "curl",
      "wget",
    ]) {
      const path = join(bin, command);
      await writeFile(path, `#!/bin/sh\n: > '${join(evidence, command)}'\nexit 97\n`);
      await chmod(path, 0o755);
    }
    await writeFile(join(workspace, "fixture.ts"), "export const value = 1;\n");
    await writeFile(join(workspace, "fixture.py"), "value = 1\n");
    const steps = [
      { tool: "read", input: { path: join(workspace, "fixture.ts") } },
      {
        tool: "edit",
        input: {
          path: join(workspace, "fixture.ts"),
          oldString: "value = 1",
          newString: "value = 2",
        },
      },
      { tool: "read", input: { path: join(workspace, "fixture.py") } },
      {
        tool: "edit",
        input: {
          path: join(workspace, "fixture.py"),
          oldString: "value = 1",
          newString: "value = 2",
        },
      },
      {
        tool: "write",
        input: { path: join(workspace, "new.ts"), content: "export const fresh = 3;\n" },
      },
      { tool: "write", input: { path: join(workspace, "new.py"), content: "fresh = 3\n" } },
    ];
    let calls = 0;
    const catalogs: string[][] = [];
    const model = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(body);
      // A title-agent call must not advance the fixture's tool sequence.
      const tools = (input.tools ?? []).map(
        (tool: { function: { name: string } }) => tool.function.name,
      );
      catalogs.push(tools);
      const step = tools.includes("edit") ? steps[calls++] : undefined;
      const delta = step
        ? {
            tool_calls: [
              {
                index: 0,
                id: `call_${calls}`,
                type: "function",
                function: { name: step.tool, arguments: JSON.stringify(step.input) },
              },
            ],
          }
        : { content: "Fixture complete." };
      const chunk = (value: unknown, finish: string | null) =>
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `${chunk(delta, null)}${chunk({}, step ? "tool_calls" : "stop")}data: [DONE]\n\n`,
      );
    });
    // Observe proxy-aware HTTP/CONNECT attempts under this fixture's exclusions.
    // Zero requests do not establish deployed supervisor download/egress behavior
    // or OS-level confinement. Tagged source establishes the lack of LSP runtime.
    const proxyRequests: string[] = [];
    const proxy = createServer((request, response) => {
      proxyRequests.push(request.url ?? "unknown");
      response.writeHead(502);
      response.end();
    });
    proxy.on("connect", (request, socket) => {
      proxyRequests.push(request.url ?? "CONNECT");
      socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    });
    await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const modelAddress = model.address();
    const proxyAddress = proxy.address();
    if (
      !modelAddress ||
      typeof modelAddress === "string" ||
      !proxyAddress ||
      typeof proxyAddress === "string"
    )
      throw new Error("Missing fixture addresses");
    const rendered = renderOpenCodeConfigForCycle(
      {
        ...preparation,
        // Keep prepared grants/server identities, but exclude all MCP loading.
        openCodeMcpServers: Object.fromEntries(
          Object.entries(preparation.openCodeMcpServers).map(([name, server]) => [
            name,
            { ...server, alwaysLoad: false },
          ]),
        ),
      },
      "fixture",
      {
        model: "fixture",
        providers: [
          {
            id: "fixture",
            package: "@opencode/ai/providers/openai-compatible",
            settings: { baseURL: `http://127.0.0.1:${modelAddress.port}/v1` },
          },
        ],
      },
    );
    expect(rendered.config).not.toHaveProperty("lsp");
    const files = await writeOpenCodeConfig(state, rendered);
    const enforcement = JSON.parse(rendered.enforcementJson);
    // Snapshot only: an explicit configured language server stays inert in 2.1.2.
    // The exact version assertion intentionally excludes future runtime behavior.
    enforcement.lsp = { canary: { command: [sentinel], extensions: [".ts", ".py"] } };
    const password = randomBytes(32).toString("hex");
    const proxyURL = `http://127.0.0.1:${proxyAddress.port}`;
    const child = spawn(binary, ["serve", "--stdio", "--hostname=127.0.0.1", "--port=0"], {
      cwd: workspace,
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: root,
        XDG_CONFIG_HOME: join(state, "xdg-config"),
        XDG_DATA_HOME: join(state, "xdg-data"),
        XDG_CACHE_HOME: join(state, "cache"),
        XDG_STATE_HOME: join(state, "xdg-state"),
        OPENCODE_TEST_HOME: state,
        OPENCODE_DB: join(state, "opencode.db"),
        OPENCODE_CONFIG: files.configPath,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(enforcement),
        OPENCODE_PASSWORD: password,
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        // Test-only exclusion of FFF/native indexing, not a supervisor setting.
        OPENCODE_DISABLE_FFF: "1",
        // MCP loading is disabled above; no live Jira service participates.
        JIRA_MCP_URL: "http://127.0.0.1:1/mcp",
        NPM_CONFIG_OFFLINE: "true",
        npm_config_offline: "true",
        HTTP_PROXY: proxyURL,
        HTTPS_PROXY: proxyURL,
        http_proxy: proxyURL,
        https_proxy: proxyURL,
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let diagnostics = "";
    child.stderr.on("data", (chunk) => {
      diagnostics += chunk;
    });
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 60000);
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let output = "";
        child.stdout.on("data", (chunk) => {
          output += chunk;
          for (const line of output.split("\n")) {
            try {
              const parsed = JSON.parse(line);
              if (parsed.url) resolve(parsed.url);
            } catch {
              /* Partial line. */
            }
          }
        });
        child.once("error", reject);
        child.once("exit", (code) =>
          reject(new Error(`Native startup exit ${code}: ${diagnostics}`)),
        );
      });
      const client = OpenCode.make({
        baseUrl: url,
        headers: {
          authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
        },
      });
      const options = { signal: AbortSignal.timeout(40000) };
      const location = { directory: workspace };
      for (const id of [
        "opencode.config.provider",
        "opencode.config.policy",
        "opencode.config.agent",
        "opencode.config.mcp",
        "opencode.tool.edit",
        "opencode.tool.write",
        "opencode.tool.read",
      ])
        await expect
          .poll(
            async () =>
              (await client.plugin.list({ location }, options)).data.find(
                (plugin) => plugin.id === id,
              )?.state.status,
            { timeout: 10000, message: id },
          )
          .toBe("active");
      const plugins = (await client.plugin.list({ location }, options)).data;
      expect(
        plugins.some((plugin) =>
          ["opencode.tools", "opencode.tools.mcp-resources"].includes(plugin.id ?? ""),
        ),
      ).toBe(false);
      const session = await client.session.create(
        {
          location,
          title: "Production allowlist",
          model: { providerID: "fixture", id: "fixture" },
        },
        options,
      );
      await client.session.prompt(
        { sessionID: session.id, text: "Run native editing fixture." },
        options,
      );
      await client.session.wait({ sessionID: session.id }, options);
      expect((await client.session.get({ sessionID: session.id }, options)).outcome).toBe(
        "succeeded",
      );
      expect(await readFile(join(workspace, "fixture.ts"), "utf8")).toBe(
        "export const value = 2;\n",
      );
      expect(await readFile(join(workspace, "fixture.py"), "utf8")).toBe("value = 2\n");
      expect(await readFile(join(workspace, "new.ts"), "utf8")).toBe("export const fresh = 3;\n");
      expect(await readFile(join(workspace, "new.py"), "utf8")).toBe("fresh = 3\n");
      expect(calls).toBe(steps.length + 1);
      expect(catalogs.some((tools) => tools.includes("edit") && tools.includes("write"))).toBe(
        true,
      );
      expect(catalogs.flat().some((tool) => /lsp/i.test(tool))).toBe(false);
      // No configured LSP/PATH sentinel attempts during these pinned file-tool calls.
      expect(await readdir(evidence)).toEqual([]);
      // Fixture observation only: FFF/native indexing and MCP loading were excluded.
      expect(proxyRequests).toEqual([]);
    } finally {
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
      clearTimeout(killTimer);
      for (const server of [model, proxy]) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      await rm(root, { recursive: true, force: true });
    }
  },
  90000,
);
