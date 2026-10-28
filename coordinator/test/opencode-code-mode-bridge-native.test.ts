import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { OpenCode, type OpenCodeEvent } from "@opencode/client";
import { expect, it } from "vitest";
import type { OpenCodeCodeModeEvidence } from "../src/runtimes/opencode/code-mode-bridge";
import { buildOpenCodeEnvironment } from "../src/runtimes/opencode/environment";
import { renderOpenCodePolicyPlugin } from "../src/runtimes/opencode/policy-plugin";

// Pinned native engine, synthetic provider and MCP only. No saved credentials,
// paid inference, renderer changes, or dependency installation.
it.skipIf(!process.env.REHOR_TEST_OPENCODE_BINARY)(
  "bridges native root/child MCP and identical scalar calls across async validation",
  async () => {
    const binary = process.env.REHOR_TEST_OPENCODE_BINARY;
    if (!binary) throw new Error("REHOR_TEST_OPENCODE_BINARY required");
    expect(spawnSync(binary, ["--version"], { encoding: "utf8" }).stdout.trim()).toBe(
      "opencode v2.1.2",
    );
    const root = await realpath(await mkdtemp(join(tmpdir(), "rehor-code-mode-native-")));
    const workspace = join(root, "workspace");
    const plugin = join(root, "plugin");
    const fixturePlugin = join(root, "fixture-plugin");
    await mkdir(workspace);
    await mkdir(plugin);
    await mkdir(fixturePlugin);
    await writeFile(join(plugin, "package.json"), '{"type":"module"}');
    await writeFile(join(plugin, "index.js"), renderOpenCodePolicyPlugin(undefined, undefined));
    await writeFile(join(fixturePlugin, "package.json"), '{"type":"module"}');
    await writeFile(
      join(fixturePlugin, "index.js"),
      `
      import { Effect, Schema } from "effect";
      const calls = new Map();
      const next = (name, context) => {
        const key = context.sessionID + ":" + name;
        const index = calls.get(key) ?? 0;
        calls.set(key, index + 1);
        return index;
      };
      let decodes = 0;
      const standard = (validate) => ({ "~standard": {
        version: 1, vendor: "bridge-native-fixture", validate,
        jsonSchema: { input: () => ({ type: "null" }), output: () => ({ type: "string" }) }
      }});
      export default { id: "bridge-native-fixture", effect: (ctx) =>
        ctx.tool.transform((editor) => {
          const options = { namespace: "bridge", codemode: true };
          editor.add({ name: "scalar", options, description: "Identical scalar failure/success",
            input: Schema.Null, output: Schema.String,
            execute: (_input, context) => Effect.gen(function* () {
              if (next("scalar", context) === 0) {
                yield* Effect.sleep(40);
                return yield* Effect.fail(new Error("first scalar executor failed"));
              }
              return { output: "second scalar succeeded" };
            })
          });
          editor.add({ name: "validated", options, description: "Async output validation",
            input: Schema.Null,
            output: standard(async (value) => {
              await new Promise((resolve) => setTimeout(resolve, value === "first" ? 40 : 1));
              return value === "first" ? { issues: [{ message: "first output failed" }] } : { value };
            }),
            execute: (_input, context) => Effect.succeed({
              output: next("validated", context) === 0 ? "first" : "second output succeeded"
            })
          });
          editor.add({ name: "decoded", options, description: "Async input validation",
            input: standard(async (value) => {
              const first = decodes++ % 2 === 0;
              await new Promise((resolve) => setTimeout(resolve, first ? 40 : 1));
              return first ? { issues: [{ message: "first input failed" }] } : { value };
            }),
            output: Schema.String,
            execute: () => Effect.succeed({ output: "second decoder succeeded" })
          });
          editor.add({ name: "failure", options, description: "Foreign and immutable failures",
            input: Schema.String, output: Schema.String,
            execute: (kind) => Effect.suspend(() => {
              const values = {
                string: "native string failure", undefined: undefined, null: null,
                object: { message: "native object failure" },
                immutable: Object.freeze(new Error("native immutable Error"))
              };
              return Effect.fail(values[kind]);
            })
          });
        })
      };
    `,
    );
    const steps = { root: 0, child: 0 };
    const mcpCalls: { name: string; input: Record<string, unknown>; sessionID: string }[] = [];
    const responses: number[] = [];
    let callID = 0;
    const server = createServer(async (request, response) => {
      if (request.method !== "POST") {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("raw fetch remains independent of webfetch");
        return;
      }
      let body = "";
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(body);
      if (request.url === "/mcp") {
        if (input.id === undefined) {
          response.writeHead(202).end();
          return;
        }
        let result: unknown = {};
        if (input.method === "initialize")
          result = {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "bridge-fixture", version: "1" },
          };
        if (input.method === "tools/list")
          result = {
            tools: ["task_add", "blocked"].map((name) => ({
              name,
              description: `Synthetic ${name}`,
              inputSchema: {
                type: "object",
                properties: { index: { type: "integer" }, external_key: { type: "string" } },
                required: ["index", "external_key"],
              },
              outputSchema: {
                type: "object",
                properties: { id: { type: "integer" }, external_key: { type: "string" } },
                required: ["id", "external_key"],
              },
            })),
          };
        if (input.method === "tools/call") {
          const args = input.params.arguments;
          mcpCalls.push({
            name: input.params.name,
            input: args,
            sessionID: input.params._meta["ai.opencode/sessionID"],
          });
          await new Promise((resolve) => setTimeout(resolve, args.index === 0 ? 40 : 1));
          responses.push(args.index);
          result = {
            content: [{ type: "text", text: "unfiltered task result" }],
            structuredContent: { id: args.index + 200, external_key: args.external_key },
          };
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: input.id, result }));
        return;
      }
      const names = (input.tools ?? []).map(
        (tool: { function: { name: string } }) => tool.function.name,
      );
      const role = JSON.stringify(
        input.messages.filter((message: { role: string }) => message.role === "user"),
      ).includes("BRIDGE CHILD")
        ? "child"
        : "root";
      const step = names.includes("execute") ? steps[role]++ : -1;
      const tool =
        step === 0 || step === 1
          ? "execute"
          : role === "root" && step === 2
            ? "subagent"
            : undefined;
      const args =
        tool === "execute"
          ? {
              code:
                step === 1
                  ? `await Promise.allSettled(["string", "undefined", "null", "object", "immutable"].map((kind) => tools.bridge.failure(kind))); throw "outer native failure";`
                  : `await Promise.allSettled([
                tools["bot-memory"].task_add({index:0,external_key:"SYNTHETIC-${role}"}),
                tools["bot-memory"].task_add({index:1,external_key:"SYNTHETIC-${role}"}),
                tools["bot-memory"].blocked({index:2,external_key:"SYNTHETIC-${role}"}),
                tools.bridge.scalar(null), tools.bridge.scalar(null),
                tools.bridge.validated(null), tools.bridge.validated(null),
                tools.bridge.decoded(null), tools.bridge.decoded(null)
              ]); await fetch("http://127.0.0.1:${(server.address() as { port: number }).port}/raw"); return "filtered";`,
            }
          : { agent: "worker", description: "Bridge child fixture", prompt: "BRIDGE CHILD" };
      const delta = tool
        ? {
            tool_calls: [
              {
                index: 0,
                id: `call_${++callID}`,
                type: "function",
                function: { name: tool, arguments: JSON.stringify(args) },
              },
            ],
          }
        : { content: "Bridge fixture complete." };
      const chunk = (value: unknown, finish: string | null) =>
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `${chunk(delta, null)}${chunk({}, tool ? "tool_calls" : "stop")}data: [DONE]\n\n`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture address");
    const config = join(root, "opencode.json");
    await writeFile(
      config,
      JSON.stringify({
        model: "fixture/fixture",
        share: "disabled",
        update: "disable",
        providers: {
          fixture: {
            package: "@opencode/ai/providers/openai-compatible",
            settings: { baseURL: `http://127.0.0.1:${address.port}/v1` },
            models: { fixture: { name: "fixture" } },
          },
        },
        mcp: {
          servers: {
            "bot-memory": {
              type: "remote",
              url: `http://127.0.0.1:${address.port}/mcp`,
              codemode: true,
              oauth: false,
            },
          },
        },
        permissions: [
          { action: "*", resource: "*", effect: "deny" },
          { action: "execute", resource: "*", effect: "allow" },
          { action: "subagent", resource: "worker", effect: "allow" },
          { action: "bot-memory_task_add", resource: "*", effect: "allow" },
          { action: "bridge_*", resource: "*", effect: "allow" },
          // Visible in discovery, denied at the actual MCP resource '*'.
          { action: "bot-memory_blocked", resource: "not-the-actual-resource", effect: "allow" },
        ],
        agents: { title: { model: "fixture/fixture" }, worker: { mode: "subagent" } },
        policies: [
          { action: "provider.use", resource: "*", effect: "deny" },
          { action: "provider.use", resource: "fixture", effect: "allow" },
        ],
        plugins: [
          pathToFileURL(fixturePlugin).href,
          pathToFileURL(plugin).href,
          "-opencode.tools",
          "-opencode.tools.mcp-resources",
        ],
      }),
    );
    const password = randomBytes(32).toString("hex");
    const env = buildOpenCodeEnvironment({ base: { PATH: process.env.PATH, HOME: root } });
    Object.assign(env, {
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_CACHE_HOME: join(root, "cache"),
      XDG_STATE_HOME: join(root, "state"),
      OPENCODE_TEST_HOME: root,
      OPENCODE_DB: join(root, "opencode.db"),
      OPENCODE_CONFIG: config,
      OPENCODE_PASSWORD: password,
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_FFF: "1",
      NPM_CONFIG_OFFLINE: "true",
      npm_config_offline: "true",
    });
    const child = spawn(binary, ["serve", "--stdio", "--hostname=127.0.0.1", "--port=0"], {
      cwd: workspace,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let diagnostics = "";
    child.stderr.on("data", (chunk) => {
      diagnostics += chunk;
    });
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 60000);
    const eventAbort = new AbortController();
    let recording: Promise<void> | undefined;
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
        child.once("exit", (code) => reject(new Error(`Native exit ${code}: ${diagnostics}`)));
      });
      const client = OpenCode.make({
        baseUrl: url,
        headers: {
          authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
        },
      });
      const options = { signal: AbortSignal.timeout(45000) };
      const location = { directory: workspace };
      await expect
        .poll(
          async () =>
            (await client.plugin.list({ location }, options)).data.find(
              (item) => item.id === "rehor-policy",
            )?.state.status,
          { timeout: 15000 },
        )
        .toBe("active");
      expect((await client.plugin.list({ location }, options)).data, diagnostics).toContainEqual(
        expect.objectContaining({ id: "bridge-native-fixture", state: { status: "active" } }),
      );
      await expect
        .poll(
          async () =>
            (await client.mcp.list({ location }, options)).data.find(
              (item) => item.name === "bot-memory",
            )?.status.status,
          { timeout: 15000 },
        )
        .toBe("connected");
      // Native MCP registry changes debounce for 100ms after connection settles.
      await new Promise((resolve) => setTimeout(resolve, 200));
      const events: OpenCodeEvent[] = [];
      const iterator = client.event
        .subscribe({ signal: eventAbort.signal })
        [Symbol.asyncIterator]();
      await iterator.next();
      recording = (async () => {
        for (;;) {
          const next = await iterator.next();
          if (next.done) break;
          events.push(next.value);
        }
      })().catch((error: unknown) => {
        if (!eventAbort.signal.aborted) throw error;
      });
      const session = await client.session.create(
        { location, model: { providerID: "fixture", id: "fixture" } },
        options,
      );
      await client.session.prompt({ sessionID: session.id, text: "BRIDGE ROOT" }, options);
      await client.session.wait({ sessionID: session.id }, options);
      expect(
        (await client.session.get({ sessionID: session.id }, options)).outcome,
        diagnostics,
      ).toBe("succeeded");
      const children = await client.session.list({ parentID: session.id, limit: 10 }, options);
      expect(children.data).toHaveLength(1);
      expect(
        mcpCalls,
        JSON.stringify(await client.session.context({ sessionID: session.id }, options)),
      ).toHaveLength(4);
      expect(mcpCalls.every((call) => call.name === "task_add")).toBe(true);
      expect(responses).toEqual([1, 0, 1, 0]);
      for (const [role, id] of [
        ["root", session.id],
        ["child", children.data[0].id],
      ] as const) {
        await expect
          .poll(() =>
            events.some(
              (event) =>
                event.type === "session.execution.succeeded" && event.data.sessionID === id,
            ),
          )
          .toBe(true);
        const successes = events.filter(
          (event) => event.type === "session.tool.success" && event.data.sessionID === id,
        );
        const executed = successes.find(
          (event) => "metadata" in event.data && event.data.metadata?.rehorCodeMode,
        );
        expect(executed, diagnostics).toBeDefined();
        if (!executed) throw new Error("Missing native execute success");
        const executedID = (executed.data as { id: string }).id;
        const metadata = (executed.data as unknown as { metadata: Record<string, unknown> })
          .metadata;
        const evidence = metadata.rehorCodeMode as OpenCodeCodeModeEvidence;
        expect(evidence.calls.map((row) => [row.name, row.status])).toEqual([
          ["bot-memory_task_add", "completed"],
          ["bot-memory_task_add", "completed"],
          ["bot-memory_blocked", "error"],
          ["bridge_scalar", "error"],
          ["bridge_scalar", "completed"],
          ["bridge_validated", "error"],
          ["bridge_validated", "completed"],
          ["bridge_decoded", "error"],
          ["bridge_decoded", "completed"],
        ]);
        expect(new Set(evidence.calls.map((row) => row.id)).size).toBe(9);
        expect(evidence.calls.every((row) => row.id.startsWith(`${id}:`))).toBe(true);
        expect(evidence.calls[0].input).toEqual({ index: 0, external_key: `SYNTHETIC-${role}` });
        expect(JSON.stringify(evidence.calls[0].content)).toContain("unfiltered task result");
        expect(JSON.stringify(evidence.calls[0].content)).toContain('\\"id\\":200');
        for (const [index, text] of [
          [4, "second scalar succeeded"],
          [6, "second output succeeded"],
          [8, "second decoder succeeded"],
        ] as const) {
          expect(evidence.calls[index].input).toBeNull();
          expect(JSON.stringify(evidence.calls[index].content)).toContain(text);
        }
        expect(metadata.toolCalls).toEqual(
          expect.arrayContaining([expect.objectContaining({ tool: "fetch", status: "completed" })]),
        );
        const progress = events.filter(
          (event) =>
            event.type === "session.tool.progress" &&
            event.data.sessionID === id &&
            event.data.id === executedID &&
            event.data.metadata.rehorCodeMode,
        );
        expect(
          progress.length,
          "MCP registrations must be wrapped before the first snapshot",
        ).toBeGreaterThan(0);
        const finalProgress = progress.at(-1);
        expect(
          finalProgress && "metadata" in finalProgress.data
            ? finalProgress.data.metadata.rehorCodeMode
            : undefined,
        ).toEqual(evidence);
        const projected = await client.session.context({ sessionID: id }, options);
        expect(JSON.stringify(projected)).toContain(JSON.stringify(evidence));
        // Native V2 turns foreign typed failures into Tool.Error objects, and
        // Code Mode returns JavaScript throws as successful tool error results.
        // Preserve those semantics while retaining every nested failure row.
        const failedExecution = successes.find(
          (event) => "metadata" in event.data && event.data.metadata?.error === true,
        );
        expect(failedExecution, diagnostics).toBeDefined();
        if (!failedExecution) throw new Error("Missing native execute error result");
        const failureMetadata = (
          failedExecution.data as unknown as { metadata: Record<string, unknown> }
        ).metadata;
        const failures = failureMetadata.rehorCodeMode as OpenCodeCodeModeEvidence;
        expect(failures.calls.map((row) => [row.name, row.input, row.status, row.error])).toEqual([
          ["bridge_failure", "string", "error", "native string failure"],
          ["bridge_failure", "undefined", "error", "undefined"],
          ["bridge_failure", "null", "error", "null"],
          ["bridge_failure", "object", "error", "[object Object]"],
          ["bridge_failure", "immutable", "error", "native immutable Error"],
        ]);
        expect(JSON.stringify(projected)).toContain(JSON.stringify(failures));
        expect(JSON.stringify(projected)).toContain("outer native failure");
        expect((await client.plugin.list({ location }, options)).data).toContainEqual(
          expect.objectContaining({ id: "rehor-policy", state: { status: "active" } }),
        );
        expect(mcpCalls.filter((call) => call.sessionID === id)).toHaveLength(2);
      }
    } finally {
      eventAbort.abort();
      await recording;
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
      clearTimeout(killTimer);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
  90000,
);
