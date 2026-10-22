import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createGrpcServer, type ServerHttp2Stream } from "node:http2";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OpenCode, type OpenCodeEvent } from "@opencode/client";
import { expect, it } from "vitest";
import { createEventFactory, parseRehorRun } from "../src/domain";
import { WorkContextTracker } from "../src/domain/work-context";
import {
  createNormalizationContext,
  normalizeOpenCodeEvent,
} from "../src/runtimes/opencode/normalizer";
import { OpenCodeServerSupervisor } from "../src/runtimes/opencode/process-supervisor";
import { renderOpenCodeConfigForCycle } from "../src/runtimes/opencode/render";
import runFixture from "./fixtures/rehor-run.v1.json";

// ExecuteRequest/Response contain only length-delimited fields here. Keep this
// tiny localhost gRPC fixture dependency-free; production client uses real Go gRPC.
function stringField(number: number, value: string): Buffer {
  const bytes = Buffer.from(value);
  const size = [];
  let length = bytes.length;
  do {
    size.push((length & 127) | (length > 127 ? 128 : 0));
    length >>>= 7;
  } while (length);
  return Buffer.concat([Buffer.from([number * 8 + 2, ...size]), bytes]);
}

function requestFields(frame: Buffer): { tool: string; args: string[] } {
  expect(frame[0]).toBe(0);
  expect(frame.readUInt32BE(1)).toBe(frame.length - 5);
  const fields: Record<number, string[]> = {};
  let offset = 5;
  while (offset < frame.length) {
    const tag = frame[offset++];
    expect(tag & 7).toBe(2);
    let length = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = frame[offset++];
      length += (byte & 127) * 2 ** shift;
      shift += 7;
    } while (byte & 128);
    const values = fields[tag >>> 3] ?? [];
    fields[tag >>> 3] = values;
    values.push(frame.subarray(offset, offset + length).toString());
    offset += length;
  }
  return { tool: fields[1]?.[0] ?? "", args: fields[2] ?? [] };
}

let completionID = 0;

function completion(tool?: string, args?: Record<string, unknown>): string {
  const delta = tool
    ? {
        tool_calls: [
          {
            index: 0,
            id: `call_${++completionID}_${tool}`,
            type: "function",
            function: { name: tool, arguments: JSON.stringify(args) },
          },
        ],
      }
    : { content: "Synthetic environment check complete." };
  const chunk = (value: unknown, finish: string | null) =>
    `data: ${JSON.stringify({ id: "chatcmpl_fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`;
  return `${chunk(delta, null)}${chunk({}, tool ? "tool_calls" : "stop")}data: [DONE]\n\n`;
}

// Opt in with pinned OpenCode V2, Go, and python3 on PATH. No paid inference,
// saved credentials, real services, or helper mutations: all endpoints are loopback.
it.skipIf(!process.env.REHOR_TEST_OPENCODE_BINARY).each(["set", "empty", "unset"] as const)(
  "preserves native root/child environment (%s XDG), helpers, credential isolation and policy ceiling",
  async (xdgMode) => {
    const binary = process.env.REHOR_TEST_OPENCODE_BINARY;
    if (!binary) throw new Error("REHOR_TEST_OPENCODE_BINARY required");
    const version = spawnSync(binary, ["--version"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH },
    });
    expect(version.error, `Cannot execute OpenCode binary: ${binary}`).toBeUndefined();
    expect(version.status, `OpenCode version probe failed: ${version.stderr}`).toBe(0);
    expect(version.stdout.trim()).toBe("opencode v2.1.2");
    const home = await realpath(await mkdtemp(join(tmpdir(), "rehor-environment-native-")));
    const workspace = join(home, "workspace");
    await mkdir(workspace);
    const approved = join(home, "approved");
    const outside = join(home, "outside");
    await mkdir(approved);
    await mkdir(outside);
    await writeFile(join(approved, "public.txt"), "synthetic-approved-read");
    await writeFile(join(approved, "private.txt"), "synthetic-agent-denied-content");
    await writeFile(join(outside, "secret.txt"), "synthetic-outside-content-must-not-be-read");
    const configHome =
      xdgMode === "set" ? join(home, "config") : xdgMode === "empty" ? "" : undefined;
    const dataHome = xdgMode === "set" ? join(home, "data") : xdgMode === "empty" ? "" : undefined;
    // Seed both explicit and HOME-default data locations, never real credentials.
    for (const data of [join(home, "data"), join(home, ".local/share")]) {
      await mkdir(join(data, "opencode"), { recursive: true });
      await writeFile(
        join(data, "opencode/auth.json"),
        JSON.stringify({
          ambient: { type: "api", key: "synthetic-ambient-credential-must-not-import" },
        }),
      );
    }
    const rpcRequests: { path: unknown; frame: Buffer }[] = [];
    const grpc = createGrpcServer();
    grpc.on("stream", (stream: ServerHttp2Stream, headers) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        rpcRequests.push({ path: headers[":path"], frame: Buffer.concat(chunks) });
        const message = stringField(1, "synthetic-executor-ok\n");
        const frame = Buffer.alloc(5);
        frame.writeUInt32BE(message.length, 1);
        stream.respond(
          { ":status": 200, "content-type": "application/grpc" },
          { waitForTrailers: true },
        );
        stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
        stream.end(Buffer.concat([frame, message]));
      });
    });
    const runnerEnv = [
      "OPENCODE_CONFIG",
      "OPENCODE_CONFIG_CONTENT",
      "OPENCODE_CONFIG_DIR",
      "OPENCODE_TEST_HOME",
      "OPENCODE_DB",
      "OPENCODE_AUTH_CONTENT",
      "OPENCODE_PASSWORD",
      "OPENCODE_SERVER_PASSWORD",
    ];
    const command = (role: string) =>
      `${runnerEnv.map((name) => `test "\${${name}+present}" != present`).join(" && ")} && printf '%s\\n' "$EXECUTOR_ADDR" "$BOT_JIRA_EMAIL" "$BOT_INSTANCE_ID" "$BOT_MEMORY_URL" "$GH_USER_NAME" "$GL_USER_NAME" "$BOT_CONFIG_PATH" "$SLACK_NOTIFY_MODE" "$GH_RELEASE_UPLOAD_URL" "$BOT_BOARD_ID" "$BOT_BOARD_NAME" "$SLACK_WEBHOOK_URL" > shell-${role}.txt && python3 helper.py ${role}`;
    const modelRequests: Record<string, unknown>[] = [];
    const modelTransport: { path: string | undefined; authorization: string | undefined }[] = [];
    const steps = { root: 0, child: 0 };
    const mcpCalls: string[] = [];
    const model = createServer(async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405);
        res.end();
        return;
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      const request = JSON.parse(body);
      if (req.url === "/mcp") {
        if (request.id === undefined) {
          res.writeHead(202);
          res.end();
          return;
        }
        let result: unknown = {};
        if (request.method === "initialize")
          result = {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1" },
          };
        if (request.method === "tools/list")
          result = {
            tools: ["search", "delete", "task_update"].map((name) => ({
              name,
              description: `Synthetic ${name}`,
              inputSchema: {
                type: "object",
                properties: {
                  query: { type: "string" },
                  external_key: { type: "string" },
                  repo: { type: "string" },
                  status: { type: "string" },
                },
              },
            })),
          };
        if (request.method === "tools/call") {
          mcpCalls.push(request.params.name);
          result = { content: [{ type: "text", text: "synthetic-mcp-search-ok" }] };
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
        return;
      }
      modelRequests.push(request);
      modelTransport.push({ path: req.url, authorization: req.headers.authorization });
      const tools = (request.tools ?? []).map(
        (tool: { function: { name: string } }) => tool.function.name,
      );
      if (!tools.includes("shell")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(completion());
        return;
      }
      const users = request.messages.filter((message: { role: string }) => message.role === "user");
      const role = JSON.stringify(users).includes("NATIVE CHILD ENVIRONMENT") ? "child" : "root";
      const step = steps[role]++;
      const response =
        step === 0
          ? completion("shell", { command: command(role) })
          : step === 1
            ? completion("read", { path: join(approved, "public.txt") })
            : step === 2
              ? completion("read", { path: join(approved, "private.txt") })
              : step === 3
                ? completion("read", { path: join(outside, "secret.txt") })
                : step === 4
                  ? completion("fixture_search", { query: role })
                  : step === 5
                    ? completion("fixture_delete", {})
                    : step === 6
                      ? completion("bot-memory_task_update", {
                          external_key: `SYNTHETIC-${role}`,
                          repo: "synthetic/repository",
                          status: "pr_open",
                        })
                      : step === 7 && role === "root"
                        ? completion("subagent", {
                            agent: "env-worker",
                            description: "Check child environment",
                            prompt: "NATIVE CHILD ENVIRONMENT",
                          })
                        : completion();
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(response);
    });
    let supervisor: OpenCodeServerSupervisor | undefined;
    const eventAbort = new AbortController();
    let recording: Promise<void> | undefined;
    let recordingError: unknown;
    try {
      const build = spawnSync(
        "go",
        ["build", "-o", join(workspace, "executor-client"), "./cmd/client"],
        {
          cwd: fileURLToPath(new URL("../../proxy/executor/", import.meta.url)),
          encoding: "utf8",
          timeout: 120_000,
        },
      );
      expect(build.error, build.stderr).toBeUndefined();
      expect(build.status, build.stderr).toBe(0);
      // Use the same binary as a gh-shaped thin client, exercising argv[0] dispatch.
      await copyFile(join(workspace, "executor-client"), join(workspace, "gh"));
      await Promise.all([
        new Promise<void>((resolve) => grpc.listen(0, "127.0.0.1", resolve)),
        new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve)),
      ]);
      const grpcAddress = grpc.address();
      const modelAddress = model.address();
      if (
        !grpcAddress ||
        typeof grpcAddress === "string" ||
        !modelAddress ||
        typeof modelAddress === "string"
      )
        throw new Error("Missing mock address");
      const operational = {
        EXECUTOR_ADDR: `127.0.0.1:${grpcAddress.port}`,
        BOT_JIRA_EMAIL: "fixture-bot@example.invalid",
        BOT_INSTANCE_ID: "synthetic-instance-199",
        BOT_MEMORY_URL: "http://127.0.0.1:18080/synthetic-memory",
        GH_USER_NAME: "synthetic-github-bot",
        GL_USER_NAME: "synthetic-gitlab-bot",
        BOT_CONFIG_PATH: join(home, "synthetic-config"),
        SLACK_NOTIFY_MODE: "batch",
        GH_RELEASE_UPLOAD_URL: "http://127.0.0.1:18446/upload",
        BOT_BOARD_ID: "42",
        BOT_BOARD_NAME: "Synthetic board",
        SLACK_WEBHOOK_URL: "http://127.0.0.1:18080/synthetic-webhook",
      };
      await copyFile(
        fileURLToPath(new URL("./fixtures/slack-helper-capture.py", import.meta.url)),
        join(workspace, "slack-helper-capture.py"),
      );
      await copyFile(
        fileURLToPath(
          new URL("../../presets/envs/slack/skills/slack-notify/slack_notify.py", import.meta.url),
        ),
        join(workspace, "slack_notify.py"),
      );
      await writeFile(join(workspace, "expected.json"), JSON.stringify(operational));
      await writeFile(
        join(workspace, "xdg-expected.json"),
        JSON.stringify({
          XDG_CONFIG_HOME: configHome ?? null,
          XDG_DATA_HOME: dataHome ?? null,
        }),
      );
      await writeFile(
        join(workspace, "helper.py"),
        `import json, os, pathlib, subprocess, sys
role = sys.argv[1]
expected = json.loads(pathlib.Path("expected.json").read_text())
actual = {key: os.environ.get(key) for key in expected}
assert actual == expected, actual
for key, value in json.loads(pathlib.Path("xdg-expected.json").read_text()).items():
    assert os.environ.get(key) == value, (key, os.environ.get(key), value)
runner_env = ${JSON.stringify(runnerEnv)}
assert not any(key in os.environ for key in runner_env)
# A helper's own subprocess inherits the same cleaned environment.
descendant = subprocess.run([sys.executable, "-c", "import json, os; print(json.dumps(dict(os.environ)))"], capture_output=True, text=True, check=True)
assert not any(key in json.loads(descendant.stdout) for key in runner_env)
assert pathlib.Path("shell-" + role + ".txt").read_text().splitlines() == list(expected.values())
for key in ["GH_TOKEN", "OPENAI_API_KEY", "JIRA_API_TOKEN", "JIRA_USERNAME", "SLACK_OTHER_CREDENTIAL", "BOT_SECRET_TOKEN", "EXECUTOR_TOKEN", "UNKNOWN_AMBIENT"]:
    assert key not in os.environ, key
assert os.environ["REHOR_MODEL_PROXY_TOKEN"] == "synthetic-provider-token"
result = subprocess.run(["./gh", "api", "/synthetic-" + role], capture_output=True, text=True, timeout=10)
assert result.returncode == 0, result.stderr
assert result.stdout == "synthetic-executor-ok\\n", result.stdout
slack = subprocess.run([sys.executable, "slack-helper-capture.py", "slack_notify.py"], capture_output=True, text=True, timeout=10)
assert slack.returncode == 0, slack.stderr
pathlib.Path(role + "-slack.json").write_text(slack.stdout)
pathlib.Path(role + ".json").write_text(json.dumps(actual))
print("synthetic-" + role + "-ok")
`,
      );
      const renderedConfig = renderOpenCodeConfigForCycle(
        {
          model: "fixture",
          allowedTools: [
            "Bash",
            "Task",
            "Read",
            "mcp__fixture__search",
            "mcp__bot-memory__task_update",
          ],
          openCodeMcpServers: {
            fixture: {
              type: "http",
              url: `http://127.0.0.1:${modelAddress.port}/mcp`,
              timeout: 30000,
              codemode: false,
            },
            "bot-memory": {
              type: "http",
              url: `http://127.0.0.1:${modelAddress.port}/mcp`,
              timeout: 30000,
              codemode: false,
            },
          },
        },
        "fixture-provider",
        {
          providers: [
            {
              id: "fixture-provider",
              package: "@opencode/ai/providers/openai-compatible",
              settings: {
                baseURL: `http://127.0.0.1:${modelAddress.port}/v1`,
                apiKey: "{env:REHOR_MODEL_PROXY_TOKEN}",
              },
              models: { fixture: { limit: { context: 32000, output: 4000 } } },
            },
          ],
          packages: [{ name: "@ai-sdk/openai-compatible", version: "1.0.0" }],
          additionalDirectories: [approved],
        },
        {
          settings: {
            default_agent: "env-root",
            experimental: { subagent_depth: 1 },
            agents: {
              "env-root": {
                mode: "primary",
                permissions: [
                  { action: "external_directory", resource: "*", effect: "allow" },
                  { action: "read", resource: "*", effect: "allow" },
                  { action: "read", resource: join(approved, "private.txt"), effect: "deny" },
                  { action: "shell", resource: "*", effect: "allow" },
                  { action: "subagent", resource: "*", effect: "deny" },
                  { action: "subagent", resource: "env-worker", effect: "allow" },
                ],
              },
              "env-worker": {
                description: "Synthetic environment worker",
                mode: "subagent",
                permissions: [
                  { action: "external_directory", resource: "*", effect: "allow" },
                  { action: "read", resource: "*", effect: "allow" },
                  { action: "read", resource: join(approved, "private.txt"), effect: "deny" },
                  { action: "shell", resource: "*", effect: "allow" },
                  { action: "subagent", resource: "*", effect: "deny" },
                ],
              },
            },
          },
          files: [],
        },
      );
      supervisor = new OpenCodeServerSupervisor({
        command: binary,
        workspaceRoot: home,
        startupTimeoutMs: 20000,
        renderedConfig,
        base: {
          PATH: process.env.PATH,
          HOME: home,
          XDG_CONFIG_HOME: configHome,
          XDG_DATA_HOME: dataHome,
          XDG_CACHE_HOME: join(home, "cache"),
          XDG_STATE_HOME: join(home, "state"),
          ...operational,
          REHOR_MODEL_PROXY_TOKEN: "synthetic-provider-token",
          GH_TOKEN: "synthetic-blocked",
          OPENAI_API_KEY: "synthetic-blocked",
          JIRA_API_TOKEN: "synthetic-blocked",
          JIRA_USERNAME: "synthetic-blocked",
          SLACK_OTHER_CREDENTIAL: "synthetic-blocked",
          BOT_SECRET_TOKEN: "synthetic-blocked",
          EXECUTOR_TOKEN: "synthetic-blocked",
          UNKNOWN_AMBIENT: "synthetic-blocked",
          OPENCODE_AUTH_CONTENT: '{"synthetic":{"type":"api","key":"must-be-replaced"}}',
        },
        passthrough: [
          "GH_TOKEN",
          "OPENAI_API_KEY",
          "JIRA_API_TOKEN",
          "JIRA_USERNAME",
          "SLACK_OTHER_CREDENTIAL",
          "BOT_SECRET_TOKEN",
          "EXECUTOR_TOKEN",
          "UNKNOWN_AMBIENT",
        ],
      });
      const info = await supervisor.start(workspace, AbortSignal.timeout(25000));
      const client = OpenCode.make({
        baseUrl: info.baseUrl,
        headers: {
          authorization: `Basic ${Buffer.from(`opencode:${info.password}`).toString("base64")}`,
        },
      });
      const options = { signal: AbortSignal.timeout(60000) };
      const location = { directory: workspace };
      const session = await client.session.create(
        {
          title: "Synthetic operational environment",
          agent: "env-root",
          location,
          model: { providerID: "fixture-provider", id: "fixture" },
        },
        options,
      );
      expect(await client.credential.list(options)).toEqual([]);
      await expect
        .poll(async () => (await client.plugin.list({ location }, options)).data, {
          timeout: 15000,
          interval: 100,
        })
        .toContainEqual(
          expect.objectContaining({ id: "rehor-policy", state: { status: "active" } }),
        );
      const plugins = await client.plugin.list({ location }, options);
      expect(plugins.data).toContainEqual(
        expect.objectContaining({ id: "rehor-policy", state: { status: "active" } }),
      );
      expect(
        plugins.data.some(
          (plugin) =>
            plugin.id === "opencode.tools" || plugin.id === "opencode.tools.mcp-resources",
        ),
      ).toBe(false);
      const capturedEvents: OpenCodeEvent[] = [];
      const iterator = client.event
        .subscribe({ signal: eventAbort.signal })
        [Symbol.asyncIterator]();
      // Prime the stream before dispatch; live session.tool events must not be missed.
      expect((await iterator.next()).done).toBe(false);
      recording = (async () => {
        for (;;) {
          const next = await iterator.next();
          if (next.done) break;
          capturedEvents.push(next.value);
        }
      })().catch((error: unknown) => {
        if (!eventAbort.signal.aborted) recordingError = error;
      });
      await client.session.prompt(
        { sessionID: session.id, text: "NATIVE ROOT ENVIRONMENT" },
        options,
      );
      await client.session.wait({ sessionID: session.id }, options);
      expect((await client.session.get({ sessionID: session.id }, options)).outcome).toBe(
        "succeeded",
      );
      for (const role of ["root", "child"]) {
        expect(JSON.parse(await readFile(join(workspace, `${role}.json`), "utf8"))).toEqual(
          operational,
        );
        expect(JSON.parse(await readFile(join(workspace, `${role}-slack.json`), "utf8"))).toEqual({
          calls: [
            {
              name: "slack_notify",
              arguments: {
                external_key: "SYNTHETIC-199",
                event_type: "pr_created",
                message: "Synthetic notification",
                webhook_url: operational.SLACK_WEBHOOK_URL,
                notify_mode: operational.SLACK_NOTIFY_MODE,
              },
            },
          ],
          cleanups: 1,
          result: { sent: true, fixture: "MCP argument capture only" },
        });
      }
      for (const request of rpcRequests) {
        expect(request.path).toBe("/executor.Executor/Execute");
      }
      expect(rpcRequests.map((request) => requestFields(request.frame))).toEqual([
        { tool: "gh", args: ["api", "/synthetic-root"] },
        { tool: "gh", args: ["api", "/synthetic-child"] },
      ]);
      const children = await client.session.list({ parentID: session.id, limit: 10 }, options);
      expect(children.data).toHaveLength(1);
      expect(children.data[0].parentID).toBe(session.id);
      expect(steps).toEqual({ root: 9, child: 8 });
      expect(mcpCalls).toEqual(["search", "task_update", "search", "task_update"]);
      for (const request of modelRequests) {
        const names =
          (request.tools as { function: { name: string } }[] | undefined)?.map(
            (tool) => tool.function.name,
          ) ?? [];
        expect(names).not.toContain("execute");
        expect(names).not.toContain("webfetch");
        expect(names).not.toContain("fixture_delete");
      }
      expect(modelTransport.length).toBeGreaterThan(0);
      expect(
        modelTransport.every(
          (request) =>
            request.path === "/v1/chat/completions" &&
            request.authorization === "Bearer synthetic-provider-token",
        ),
      ).toBe(true);
      for (const [role, id] of [
        ["root", session.id],
        ["child", children.data[0].id],
      ] as const) {
        await expect
          .poll(() =>
            capturedEvents.some(
              (event) =>
                event.type === "session.execution.succeeded" && event.data.sessionID === id,
            ),
          )
          .toBe(true);
        const log = capturedEvents.filter(
          (event) =>
            "data" in event &&
            event.data &&
            "sessionID" in event.data &&
            event.data.sessionID === id,
        );
        const starts = log.filter((event) => event.type === "session.tool.input.started");
        const searchStarts = starts.filter((event) => event.data.name === "fixture_search");
        expect(searchStarts).toHaveLength(1);
        const searchID = searchStarts[0].data.id;
        expect(
          log.filter((event) => event.type === "session.tool.called" && event.data.id === searchID),
        ).toEqual([
          expect.objectContaining({
            data: expect.objectContaining({ input: { query: role } }),
          }),
        ]);
        expect(
          log.filter(
            (event) => event.type === "session.tool.success" && event.data.id === searchID,
          ),
        ).toHaveLength(1);
        const taskStarts = starts.filter((event) => event.data.name === "bot-memory_task_update");
        expect(taskStarts).toHaveLength(1);
        expect(
          log.filter(
            (event) =>
              event.type === "session.tool.success" && event.data.id === taskStarts[0].data.id,
          ),
        ).toHaveLength(1);
        const rejected = starts.filter((event) => event.data.name === "fixture_delete");
        expect(rejected).toHaveLength(1);
        expect(
          log.filter(
            (event) =>
              event.type === "session.tool.failed" && event.data.id === rejected[0].data.id,
          ),
        ).toHaveLength(1);
        expect(
          starts.some((event) => event.data.name === "execute" || event.data.name === "webfetch"),
        ).toBe(false);
        const run = parseRehorRun({ ...runFixture, runtimeId: "opencode", task: null });
        const factory = createEventFactory(run, "native-config-acceptance");
        const normalization = createNormalizationContext(id, "fixture-provider/fixture");
        const work = new WorkContextTracker(run);
        const normalized = log.flatMap(
          (event) => normalizeOpenCodeEvent(event as OpenCodeEvent, factory, normalization).events,
        );
        const successfulMcp = normalized.filter(
          (event) =>
            event.kind === "tool" &&
            event.payload.state === "completed" &&
            event.payload.isError !== true &&
            ["fixture_search", "bot-memory_task_update"].includes(String(event.payload.name)),
        );
        expect(successfulMcp.map((event) => event.payload.name)).toEqual([
          "fixture_search",
          "bot-memory_task_update",
        ]);
        for (const event of normalized) work.observe(event);
        expect(normalized).toContainEqual(
          expect.objectContaining({
            kind: "tool",
            payload: expect.objectContaining({
              name: "bot-memory_task_update",
              input: {
                external_key: `SYNTHETIC-${role}`,
                repo: "synthetic/repository",
                status: "pr_open",
              },
            }),
          }),
        );
        expect(
          work.enrichTerminal(factory("terminal", { state: "succeeded" })).payload.context,
        ).toMatchObject({
          externalKey: `SYNTHETIC-${role}`,
          repository: "synthetic/repository",
          workType: "new_ticket",
        });
        const context = JSON.stringify(await client.session.context({ sessionID: id }, options));
        expect(context).toContain("synthetic-approved-read");
        expect(context).toContain("Blocked by configuration policy");
        expect(context).toContain("Permission denied: read");
        expect(context).toContain("synthetic-mcp-search-ok");
        expect(context).not.toContain("synthetic-agent-denied-content");
        expect(context).not.toContain("synthetic-outside-content-must-not-be-read");
      }
      expect(JSON.stringify(modelRequests)).not.toContain(
        "synthetic-ambient-credential-must-not-import",
      );
      expect(recordingError).toBeUndefined();
    } finally {
      eventAbort.abort();
      await recording;
      await supervisor?.stop();
      await Promise.all([
        new Promise<void>((resolve) => model.close(() => resolve())),
        new Promise<void>((resolve) => grpc.close(() => resolve())),
      ]);
      await rm(home, { recursive: true, force: true });
    }
  },
  180000,
);
