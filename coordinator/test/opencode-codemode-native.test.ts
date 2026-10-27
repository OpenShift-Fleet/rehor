import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { expect, it } from "vitest";
import { OpenCodeServerSupervisor } from "../src/runtimes/opencode/process-supervisor";
import { renderOpenCodeConfigForCycle } from "../src/runtimes/opencode/render";

let callID = 0;
function completion(tool?: string, input: Record<string, unknown> = {}): string {
  const delta = tool
    ? {
        tool_calls: [
          {
            index: 0,
            id: `native_${++callID}`,
            type: "function",
            function: { name: tool, arguments: JSON.stringify(input) },
          },
        ],
      }
    : { content: "Native MCP fixture complete." };
  const chunk = (value: unknown, finish: string | null) =>
    `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`;
  return `${chunk(delta, null)}${chunk({}, tool ? "tool_calls" : "stop")}data: [DONE]\n\n`;
}

// No paid inference: actual pinned V2 engine, local model protocol fixture and MCP.
it.skipIf(!process.env.REHOR_TEST_OPENCODE_BINARY).each([undefined, true, false])(
  "honors native MCP codemode %s and per-agent execute deny",
  async (codemode) => {
    const binary = process.env.REHOR_TEST_OPENCODE_BINARY;
    if (!binary) throw new Error("REHOR_TEST_OPENCODE_BINARY required");
    expect(spawnSync(binary, ["--version"], { encoding: "utf8" }).stdout.trim()).toBe(
      "opencode v2.1.2",
    );
    const root = await realpath(await mkdtemp(join(tmpdir(), "native-codemode-")));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const calls: { name: string; input: unknown }[] = [];
    const catalogs: Record<string, string[][]> = { ALLOW: [], DENY: [] };
    const step = { ALLOW: 0, DENY: 0 };
    const server = createServer(async (request, response) => {
      if (request.method !== "POST") {
        response.writeHead(405);
        response.end();
        return;
      }
      let text = "";
      for await (const chunk of request) text += chunk;
      const body = JSON.parse(text);
      if (request.url === "/mcp") {
        if (body.id === undefined) {
          response.writeHead(202);
          response.end();
          return;
        }
        let result: unknown = {};
        if (body.method === "initialize")
          result = {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1" },
          };
        if (body.method === "tools/list")
          result = {
            tools: ["search", "delete"].map((name) => ({
              name,
              description: name,
              inputSchema: { type: "object", properties: { query: { type: "string" } } },
            })),
          };
        if (body.method === "tools/call") {
          calls.push({ name: body.params.name, input: body.params.arguments });
          result = { content: [{ type: "text", text: "native-mcp-search-success" }] };
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
        return;
      }
      const users = JSON.stringify(
        body.messages.filter((message: { role: string }) => message.role === "user"),
      );
      const role = users.includes("DENY") ? "DENY" : "ALLOW";
      const names = (body.tools ?? []).map(
        (tool: { function: { name: string } }) => tool.function.name,
      );
      catalogs[role].push(names);
      let result = completion();
      const exposed = codemode === false ? "fixture_search" : "execute";
      const mcpCatalogReady =
        codemode === false || JSON.stringify(body.messages).includes("tools.fixture.search");
      if (names.includes(exposed) && mcpCatalogReady) {
        const index = step[role]++;
        if (index === 0)
          result =
            codemode === false
              ? completion("fixture_search", { query: role })
              : completion("execute", {
                  code: `console.log(await tools.fixture.search({query:${JSON.stringify(role)}}));`,
                });
        else if (index === 1 && role === "ALLOW")
          result =
            codemode === false
              ? completion("fixture_delete")
              : completion("execute", { code: "console.log(await tools.fixture.delete({}));" });
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(result);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing mock address");
    const config = renderOpenCodeConfigForCycle(
      {
        model: "fixture",
        allowedTools: ["mcp__fixture__search"],
        openCodeMcpServers: {
          fixture: {
            type: "http",
            url: `http://127.0.0.1:${address.port}/mcp`,
            ...(codemode === undefined ? {} : { codemode }),
          },
        },
      },
      "fixture",
      {
        providers: [
          {
            id: "fixture",
            package: "@opencode/ai/providers/openai-compatible",
            settings: { baseURL: `http://127.0.0.1:${address.port}/v1` },
            models: { fixture: { limit: { context: 32000, output: 4000 } } },
          },
        ],
      },
      {
        settings: {
          agents: {
            enabled: { mode: "primary" },
            denied: {
              mode: "primary",
              permissions: [{ action: "execute", resource: "*", effect: "deny" }],
            },
          },
        },
        files: [],
      },
    );
    const supervisor = new OpenCodeServerSupervisor({
      command: binary,
      workspaceRoot: root,
      startupTimeoutMs: 20000,
      renderedConfig: config,
      base: {
        PATH: process.env.PATH,
        HOME: root,
        XDG_DATA_HOME: join(root, "data"),
        XDG_CACHE_HOME: join(root, "cache"),
        XDG_STATE_HOME: join(root, "state"),
      },
    });
    try {
      const info = await supervisor.start(workspace, AbortSignal.timeout(25000));
      const client = OpenCode.make({
        baseUrl: info.baseUrl,
        headers: {
          authorization: `Basic ${Buffer.from(`opencode:${info.password}`).toString("base64")}`,
        },
      });
      const options = { signal: AbortSignal.timeout(30000) };
      const location = { directory: workspace };
      await expect
        .poll(
          async () =>
            (await client.mcp.list({ location }, options)).data.find(
              (item) => item.name === "fixture",
            )?.status.status,
          { timeout: 10000, interval: 100 },
        )
        .toBe("connected");
      for (const [role, agent] of [
        ["ALLOW", "enabled"],
        ["DENY", "denied"],
      ] as const) {
        const session = await client.session.create(
          {
            location,
            agent,
            title: "Native Code Mode config fixture",
            model: { providerID: "fixture", id: "fixture" },
          },
          options,
        );
        const dispatch = async () => {
          await client.session.prompt({ sessionID: session.id, text: role }, options);
          await client.session.wait({ sessionID: session.id }, options);
          return JSON.stringify(await client.session.context({ sessionID: session.id }, options));
        };
        if (role === "ALLOW" || codemode === false) {
          // MCP catalogs update asynchronously after connection. The fixture
          // dispatches only advertised tools; retry a harmless text-only turn
          // until the real V2 Code Mode catalog publishes this server.
          await expect
            .poll(async () => (await dispatch()).includes("native-mcp-search-success"), {
              timeout: 10000,
              interval: 100,
            })
            .toBe(true);
        } else await dispatch();
        expect((await client.session.get({ sessionID: session.id }, options)).outcome).toBe(
          "succeeded",
        );
        const context = JSON.stringify(
          await client.session.context({ sessionID: session.id }, options),
        );
        if (role === "ALLOW" || codemode === false)
          expect(context).toContain("native-mcp-search-success");
        else expect(context).not.toContain("native-mcp-search-success");
      }
      expect(
        catalogs.ALLOW.some((names) =>
          names.includes(codemode === false ? "fixture_search" : "execute"),
        ),
      ).toBe(true);
      expect(catalogs.DENY.length).toBeGreaterThan(0);
      expect(catalogs.DENY.every((names) => !names.includes("execute"))).toBe(true);
      if (codemode !== false)
        expect(catalogs.DENY.every((names) => !names.includes("fixture_search"))).toBe(true);
      expect(calls).toEqual(
        codemode === false
          ? [
              { name: "search", input: { query: "ALLOW" } },
              { name: "search", input: { query: "DENY" } },
            ]
          : [{ name: "search", input: { query: "ALLOW" } }],
      );
    } finally {
      await supervisor.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
  90000,
);
