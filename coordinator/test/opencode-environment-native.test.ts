import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createGrpcServer, type ServerHttp2Stream } from "node:http2";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { OpenCodeServerSupervisor } from "../src/runtimes/opencode-v1/process-supervisor";
import { renderOpenCodeV1ConfigForCycle } from "../src/runtimes/opencode-v1/render";

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

function completion(tool?: string, args?: Record<string, unknown>): string {
  const delta = tool
    ? {
        tool_calls: [
          {
            index: 0,
            id: `call_${tool}`,
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

// Opt in with pinned OpenCode 1.18.29, Go, and python3 on PATH. No paid inference,
// saved credentials, real services, or helper mutations: all endpoints are loopback.
it.skipIf(!process.env.REHOR_TEST_OPENCODE_BINARY)(
  "preserves 12 operational values through native root/child Bash and canonical Slack/Python executor helpers",
  async () => {
    const binary = process.env.REHOR_TEST_OPENCODE_BINARY;
    if (!binary) throw new Error("REHOR_TEST_OPENCODE_BINARY required");
    const version = spawnSync(binary, ["--version"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH },
    });
    expect(version.error, `Cannot execute OpenCode binary: ${binary}`).toBeUndefined();
    expect(version.status, `OpenCode version probe failed: ${version.stderr}`).toBe(0);
    expect(version.stdout.trim()).toBe("1.18.29");
    const home = await realpath(await mkdtemp(join(tmpdir(), "rehor-environment-native-")));
    const workspace = join(home, "workspace");
    await mkdir(workspace);
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
    const command = (role: string) =>
      `printf '%s\\n' "$EXECUTOR_ADDR" "$BOT_JIRA_EMAIL" "$BOT_INSTANCE_ID" "$BOT_MEMORY_URL" "$GH_USER_NAME" "$GL_USER_NAME" "$BOT_CONFIG_PATH" "$SLACK_NOTIFY_MODE" "$GH_RELEASE_UPLOAD_URL" "$BOT_BOARD_ID" "$BOT_BOARD_NAME" "$SLACK_WEBHOOK_URL" > shell-${role}.txt && python3 helper.py ${role}`;
    const modelRequests: Record<string, unknown>[] = [];
    const model = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      modelRequests.push(JSON.parse(body));
      // Request-count sequencing is intentionally pinned to OpenCode 1.18.29.
      // Title/summarization behavior or version changes require a fixture update.
      const step = modelRequests.length;
      const response =
        step === 1
          ? completion("bash", {
              command: command("root"),
              description: "Check root operational environment",
            })
          : step === 2
            ? completion("task", {
                subagent_type: "env-worker",
                description: "Check child environment",
                prompt: "Run synthetic child environment fixture.",
              })
            : step === 3
              ? completion("bash", {
                  command: command("child"),
                  description: "Check child operational environment",
                })
              : completion();
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(response);
    });
    let supervisor: OpenCodeServerSupervisor | undefined;
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
        join(workspace, "helper.py"),
        `import json, os, pathlib, subprocess, sys
role = sys.argv[1]
expected = json.loads(pathlib.Path("expected.json").read_text())
actual = {key: os.environ.get(key) for key in expected}
assert actual == expected, actual
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
      const renderedConfig = renderOpenCodeV1ConfigForCycle(
        { model: "fixture", allowedTools: ["Bash", "Task"] },
        "fixture-provider",
        {
          providers: [
            {
              id: "fixture-provider",
              npm: "@ai-sdk/openai-compatible",
              options: {
                baseURL: `http://127.0.0.1:${modelAddress.port}/v1`,
                apiKey: "{env:REHOR_MODEL_PROXY_TOKEN}",
              },
              models: { fixture: { limit: { context: 32000, output: 4000 } } },
            },
          ],
          packages: [{ name: "@ai-sdk/openai-compatible", version: "1.0.0" }],
        },
        {
          settings: {
            default_agent: "env-root",
            subagent_depth: 1,
            agent: {
              "env-root": {
                mode: "primary",
                permission: { bash: "allow", task: { "*": "deny", "env-worker": "allow" } },
              },
              "env-worker": {
                description: "Synthetic environment worker",
                mode: "subagent",
                permission: { bash: "allow", task: "deny" },
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
          XDG_DATA_HOME: join(home, "data"),
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
      const api = async (path: string, body?: unknown) => {
        const response = await fetch(
          `${info.baseUrl}${path}?directory=${encodeURIComponent(workspace)}`,
          {
            method: body === undefined ? "GET" : "POST",
            headers: { "content-type": "application/json" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(30000),
          },
        );
        expect(response.ok, await response.clone().text()).toBe(true);
        return response.json();
      };
      const session = await api("/session", { title: "Synthetic operational environment" });
      const result = await api(`/session/${session.id}/message`, {
        agent: "env-root",
        model: { providerID: "fixture-provider", modelID: "fixture" },
        parts: [{ type: "text", text: "Run root fixture then delegate child fixture." }],
      });
      expect(result.info.error).toBeUndefined();
      expect(modelRequests).toHaveLength(5);
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
      const children = await api(`/session/${session.id}/children`);
      expect(children).toHaveLength(1);
      expect(children[0].parentID).toBe(session.id);
    } finally {
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
