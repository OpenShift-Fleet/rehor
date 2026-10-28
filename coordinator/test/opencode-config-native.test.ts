import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { OpenCode } from "@opencode/client";
import { expect, it } from "vitest";
import { buildOpenCodeEnvironment } from "../src/runtimes/opencode/environment";
import { renderOpenCodePolicyPlugin } from "../src/runtimes/opencode/policy-plugin";
import { renderOpenCodeConfigForCycle, writeOpenCodeConfig } from "../src/runtimes/opencode/render";

// Independent config acceptance: exercise the real V2 engine without coupling
// policy verification to the concurrently migrated process supervisor/client adapter.
it.skipIf(!process.env.REHOR_TEST_OPENCODE_BINARY).each(["set", "empty", "unset"] as const)(
  "enforces native global ceiling, agent deny/ask and shell XDG restoration (%s)",
  async (mode) => {
    const binary = process.env.REHOR_TEST_OPENCODE_BINARY;
    if (!binary) throw new Error("REHOR_TEST_OPENCODE_BINARY required");
    expect(spawnSync(binary, ["--version"], { encoding: "utf8" }).stdout.trim()).toBe(
      "opencode v2.1.2",
    );
    const root = await realpath(await mkdtemp(join(tmpdir(), "rehor-config-native-")));
    const workspace = join(root, "workspace");
    const approved = join(root, "approved");
    const state = join(root, "state");
    const ambientData = join(root, "ambient-data");
    const plugin = join(state, "rehor-policy");
    const configHome =
      mode === "set" ? join(root, "ambient-config") : mode === "empty" ? "" : undefined;
    const dataHome = mode === "set" ? ambientData : mode === "empty" ? "" : undefined;
    for (const path of [
      workspace,
      approved,
      plugin,
      join(ambientData, "opencode"),
      join(root, ".local/share/opencode"),
    ]) {
      await mkdir(path, { recursive: true });
    }
    const publicPath = join(approved, "public.txt");
    const privatePath = join(approved, "private.txt");
    const outsidePath = join(root, "outside.txt");
    await writeFile(publicPath, "APPROVED_PUBLIC_CONTENT");
    await writeFile(privatePath, "APPROVED_PRIVATE_CONTENT");
    await writeFile(outsidePath, "OUTSIDE_CONTENT_MUST_NOT_LOAD");
    // Project grants cannot override global policies or final runner plugin removals.
    await writeFile(
      join(workspace, "opencode.json"),
      JSON.stringify({
        plugins: ["opencode.tools", "opencode.tools.mcp-resources"],
        policies: [{ action: "tool.use", resource: "external_directory:*", effect: "allow" }],
      }),
    );
    const auth = JSON.stringify({ ambient: { type: "api", key: "SYNTHETIC_AMBIENT_AUTH" } });
    await writeFile(join(ambientData, "opencode/auth.json"), auth);
    await writeFile(join(root, ".local/share/opencode/auth.json"), auth);
    let call = 0;
    const model = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(body);
      const messages = input.messages as { role: string; content: string | { text?: string }[] }[];
      const user = messages.filter((message) => message.role === "user").at(-1);
      const text =
        typeof user?.content === "string"
          ? user.content
          : (user?.content.map((part) => part.text ?? "").join("") ?? "");
      const usedTool = messages.some((message) => message.role === "tool");
      const tools = (input.tools ?? []).map(
        (tool: { function: { name: string } }) => tool.function.name,
      );
      const tool =
        !usedTool && text.startsWith("READ:")
          ? "read"
          : !usedTool && text.startsWith("SHELL:")
            ? "shell"
            : undefined;
      const args = tool === "read" ? { path: text.slice(5) } : { command: text.slice(6) };
      const delta =
        tool && tools.includes(tool)
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: `call_${++call}`,
                  type: "function",
                  function: { name: tool, arguments: JSON.stringify(args) },
                },
              ],
            }
          : { content: "Fixture complete." };
      const chunk = (value: unknown, finish: string | null) =>
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `${chunk(delta, null)}${chunk({}, "tool_calls" in delta ? "tool_calls" : "stop")}data: [DONE]\n\n`,
      );
    });
    await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
    const address = model.address();
    if (!address || typeof address === "string") throw new Error("Missing model address");
    const rendered = renderOpenCodeConfigForCycle(
      { model: "fixture", allowedTools: ["Read", "Bash"] },
      "fixture",
      {
        additionalDirectories: [approved],
        providers: [
          {
            id: "fixture",
            package: "@opencode/ai/providers/openai-compatible",
            settings: { baseURL: `http://127.0.0.1:${address.port}/v1` },
          },
        ],
        packages: [{ name: "@ai-sdk/openai-compatible", version: "3.0.54" }],
      },
      {
        settings: {
          agents: {
            broad: {
              mode: "primary",
              permissions: [{ action: "*", resource: "*", effect: "allow" }],
            },
            restricted: {
              mode: "subagent",
              permissions: [
                { action: "external_directory", resource: "*", effect: "allow" },
                { action: "read", resource: "*", effect: "allow" },
                { action: "read", resource: privatePath, effect: "deny" },
              ],
            },
            ordered: {
              mode: "subagent",
              permissions: [
                { action: "external_directory", resource: `${approved}/*`, effect: "deny" },
                { action: "external_directory", resource: "*", effect: "allow" },
              ],
            },
            ask: {
              mode: "primary",
              permissions: [{ action: "external_directory", resource: "*", effect: "ask" }],
            },
          },
        },
        files: [
          {
            path: "agents/markdown-worker.md",
            content: `---\ndescription: Native Markdown deny fixture\nmode: subagent\npermissions:\n  - { action: external_directory, resource: "*", effect: allow }\n  - { action: read, resource: "*", effect: allow }\n  - { action: read, resource: ${JSON.stringify(privatePath)}, effect: deny }\n---\nRead-only native fixture.\n`,
          },
        ],
      },
    );
    const files = await writeOpenCodeConfig(state, rendered);
    await writeFile(join(plugin, "package.json"), '{"type":"module"}');
    await writeFile(
      join(plugin, "index.js"),
      renderOpenCodePolicyPlugin(configHome, rendered.config.permissions, dataHome),
    );
    const enforcement = JSON.parse(rendered.enforcementJson);
    enforcement.plugins.push(pathToFileURL(plugin).href);
    const password = randomBytes(32).toString("hex");
    const env = buildOpenCodeEnvironment({
      base: {
        PATH: process.env.PATH,
        HOME: root,
        XDG_CONFIG_HOME: configHome,
        XDG_DATA_HOME: dataHome,
        XDG_CACHE_HOME: join(root, "cache"),
        XDG_STATE_HOME: join(root, "xdg-state"),
        OPENCODE_AUTH_CONTENT: auth,
      },
    });
    Object.assign(env, {
      XDG_CONFIG_HOME: join(state, "xdg-config"),
      XDG_DATA_HOME: join(state, "xdg-data"),
      OPENCODE_TEST_HOME: state,
      OPENCODE_DB: join(state, "opencode.db"),
      OPENCODE_CONFIG: files.configPath,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(enforcement),
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
      await expect
        .poll(
          async () =>
            (await client.plugin.list({ location }, options)).data.find(
              (item) => item.id === "rehor-policy",
            )?.state.status,
          { timeout: 15000 },
        )
        .toBe("active");
      expect(await client.credential.list(options)).toEqual([]);
      expect(
        (await client.plugin.list({ location }, options)).data.some(
          (item) => item.id === "opencode.tools" || item.id === "opencode.tools.mcp-resources",
        ),
      ).toBe(false);
      const run = async (agent: string, text: string, parentID?: string) => {
        const session = await client.session.create(
          {
            agent,
            location,
            parentID,
            title: "Native config fixture",
            model: { providerID: "fixture", id: "fixture" },
          },
          options,
        );
        await client.session.prompt({ sessionID: session.id, text }, options);
        await client.session.wait({ sessionID: session.id }, options);
        expect((await client.session.get({ sessionID: session.id }, options)).outcome).toBe(
          "succeeded",
        );
        return {
          session,
          context: JSON.stringify(await client.session.context({ sessionID: session.id }, options)),
        };
      };
      const rootSession = await run("broad", `READ:${publicPath}`);
      expect(rootSession.context).toContain("APPROVED_PUBLIC_CONTENT");
      const outside = await run("broad", `READ:${outsidePath}`, rootSession.session.id);
      expect(outside.context).toContain("Blocked by configuration policy");
      expect(outside.context).not.toContain("OUTSIDE_CONTENT_MUST_NOT_LOAD");
      const denied = await run("restricted", `READ:${privatePath}`, rootSession.session.id);
      expect(denied.context).toContain("Permission denied: read");
      expect(denied.context).not.toContain("APPROVED_PRIVATE_CONTENT");
      const markdownDenied = await run(
        "markdown-worker",
        `READ:${privatePath}`,
        rootSession.session.id,
      );
      expect(markdownDenied.context).toContain("Permission denied: read");
      expect(markdownDenied.context).not.toContain("APPROVED_PRIVATE_CONTENT");
      expect(
        (await run("ordered", `READ:${publicPath}`, rootSession.session.id)).context,
      ).toContain("APPROVED_PUBLIC_CONTENT");
      const asked = await client.session.create(
        {
          agent: "ask",
          location,
          title: "Native ask fixture",
          model: { providerID: "fixture", id: "fixture" },
        },
        options,
      );
      await client.session.prompt({ sessionID: asked.id, text: `READ:${publicPath}` }, options);
      await expect
        .poll(async () => (await client.permission.list({ sessionID: asked.id }, options)).length, {
          timeout: 10000,
        })
        .toBe(1);
      const [permission] = await client.permission.list({ sessionID: asked.id }, options);
      expect(permission.action).toBe("external_directory");
      await client.permission.reply(
        { sessionID: asked.id, requestID: permission.id, decision: "once" },
        options,
      );
      await client.session.wait({ sessionID: asked.id }, options);
      expect(
        JSON.stringify(await client.session.context({ sessionID: asked.id }, options)),
      ).toContain("APPROVED_PUBLIC_CONTENT");
      for (const role of ["root", "child"]) {
        const command = `python3 -c 'import json,os; print(json.dumps({k:os.environ.get(k) for k in ["HOME","XDG_CONFIG_HOME","XDG_DATA_HOME","XDG_CACHE_HOME","XDG_STATE_HOME","OPENCODE_PASSWORD"]}))' > ${role}.json`;
        await run(
          "broad",
          `SHELL:${command}`,
          role === "child" ? rootSession.session.id : undefined,
        );
        expect(JSON.parse(await readFile(join(workspace, `${role}.json`), "utf8"))).toEqual({
          HOME: root,
          XDG_CONFIG_HOME: configHome ?? null,
          XDG_DATA_HOME: dataHome ?? null,
          XDG_CACHE_HOME: join(root, "cache"),
          XDG_STATE_HOME: join(root, "xdg-state"),
          OPENCODE_PASSWORD: null,
        });
      }
    } finally {
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
      clearTimeout(killTimer);
      model.closeAllConnections();
      await new Promise<void>((resolve) => model.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
  90000,
);
