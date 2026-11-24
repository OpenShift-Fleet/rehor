import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const appRoot = process.env.REHOR_SMOKE_APP_ROOT ?? "/home/botuser/app";
const command = process.env.REHOR_TEST_OPENCODE_BINARY ?? "/usr/local/bin/opencode";
const { OpenCode } = await import(pathToFileURL(join(appRoot, "coordinator/node_modules/@opencode/client/dist/promise/index.js")));
const vertexAdapterUrl = pathToFileURL(join(appRoot, "coordinator/dist/vertex-provider.js"));
const vertexAdapter = await import(vertexAdapterUrl);
assert.deepEqual(Object.keys(vertexAdapter), ["createVertexProxyProvider"], "Vertex shim must expose only the V2 AI SDK factory, not a native model export");

const {
  loadOpenCodeDeploymentConfig,
  renderOpenCodeConfigForCycle,
  validateOpenCodeDeployment,
  OpenCodeServerSupervisor,
  OpenCodeRuntime,
  executeRun,
} = await import(pathToFileURL(join(appRoot, "coordinator/dist/index.js")));

const { stdout: version } = await promisify(execFile)(command, ["--version"]);
assert.match(version.trim(), /^(?:opencode v|v)?2\.1\.2$/);

const deployment = await loadOpenCodeDeploymentConfig();
assert.equal(Object.hasOwn(deployment, "model"), false, "shared defaults must not pin a model");
assert.equal(
  deployment.providers.find((provider) => provider.id === "rehor-openai").package,
  "@opencode/ai/providers/openai/responses",
  "image deployment defaults must select the native V2 Responses provider",
);
assert.equal(
  deployment.providers.find((provider) => provider.id === "rehor-openai").settings.baseURL,
  "{env:REHOR_MODEL_PROXY_URL}",
);
assert.equal(
  deployment.providers.find((provider) => provider.id === "rehor-openai").settings.apiKey,
  "{env:REHOR_MODEL_PROXY_TOKEN}",
);
assert.equal(
  deployment.providers.find((provider) => provider.id === "rehor-openai-chat").package,
  "@opencode/ai/providers/openai-compatible",
);

const globalConfig = JSON.parse(await readFile(join(appRoot, "config.json"), "utf8"));
assert.equal(globalConfig.opencode.model, "gpt-6-luna");
await assert.rejects(readFile(join(appRoot, "CLAUDE.md")), { code: "ENOENT" });

const prepared = (model, providerId) => ({
  config: {
    model,
    runtimeId: "opencode",
    providerId,
    openCodeMcpServers: {},
    allowedTools: [],
    optionalMcpServers: [],
  },
});

async function requireActivePolicy(client, location, signal) {
  const deadline = Date.now() + 10_000;
  let inventory = [];
  for (;;) {
    signal.throwIfAborted();
    const remaining = deadline - Date.now();
    assert.ok(remaining > 0, `runner policy plugin activation timed out: ${JSON.stringify(inventory)}`);
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(remaining)]);
    const plugins = await client.plugin.list({ location }, { signal: requestSignal });
    assert.ok(Array.isArray(plugins.data), "V2 plugin inventory must contain data[]");
    inventory = plugins.data;
    // Plugin.list does not await native asynchronous activation. Missing is
    // allowed only within this deadline; a reported failure must never retry.
    for (const plugin of inventory) {
      assert.equal(plugin.state?.status, "active", `a V2 plugin failed to load: ${JSON.stringify(plugin)}`);
    }
    if (inventory.some((plugin) => plugin.id === "rehor-policy")) return;
    await delay(Math.min(50, Math.max(1, deadline - Date.now())), undefined, { signal });
  }
}

const toolMarker = "image-test-read-result";
const answer = "Image provider smoke complete.";
const usageFor = (provider) => provider === "vertex"
  ? { input: 1000, output: 100, reasoning: 50, cache: { read: 2000, write: 3000 } }
  : { input: 200, output: 80, reasoning: 20, cache: { read: 800, write: 0 } };

// Wire fixtures exercise the installed native adapters, not a test-only provider.
// Both model steps carry usage so cumulative session assertions detect loss or
// duplication. Provider output includes reasoning; V2 normalizes it separately.
function providerStream(provider, model, callTool, path) {
  const args = JSON.stringify({ path });
  const sse = (type, fields = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
  if (provider === "vertex") {
    return [
      sse("message_start", { message: { id: "msg_image", role: "assistant", model, content: [], usage: { input_tokens: 1000, cache_read_input_tokens: 2000, cache_creation_input_tokens: 3000 } } }),
      sse("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }),
      sse("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "Synthetic image check" } }),
      sse("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "image-signature" } }),
      sse("content_block_stop", { index: 0 }),
      ...(callTool ? [
        sse("content_block_start", { index: 1, content_block: { type: "tool_use", id: "call_image_read", name: "read", input: {} } }),
        sse("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: args } }),
      ] : [
        sse("content_block_start", { index: 1, content_block: { type: "text", text: "" } }),
        sse("content_block_delta", { index: 1, delta: { type: "text_delta", text: answer } }),
      ]),
      sse("content_block_stop", { index: 1 }),
      sse("message_delta", { delta: { stop_reason: callTool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 150, output_tokens_details: { thinking_tokens: 50 } } }),
      sse("message_stop"),
    ].join("");
  }
  if (provider === "rehor-openai") {
    const item = callTool
      ? { type: "function_call", id: "fc_image_read", call_id: "call_image_read", name: "read", arguments: args, status: "completed" }
      : { type: "message", id: "msg_image", role: "assistant", status: "completed", content: [{ type: "output_text", text: answer, annotations: [] }] };
    const response = { id: "resp_image", object: "response", created_at: 1, model, status: "completed", output: [item], incomplete_details: null,
      usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 800 }, output_tokens: 100, output_tokens_details: { reasoning_tokens: 20 }, total_tokens: 1100 } };
    return [
      sse("response.created", { response: { ...response, status: "in_progress", output: [] } }),
      sse("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", ...(callTool ? { arguments: "" } : { content: [] }) } }),
      ...(callTool ? [
        sse("response.function_call_arguments.delta", { item_id: item.id, output_index: 0, delta: args }),
        sse("response.function_call_arguments.done", { item_id: item.id, output_index: 0, arguments: args }),
      ] : [sse("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: answer })]),
      sse("response.output_item.done", { output_index: 0, item }),
      sse("response.completed", { response }),
    ].join("");
  }
  const chunk = (choices, usage) => `data: ${JSON.stringify({ id: "chatcmpl_image", object: "chat.completion.chunk", created: 1, model, choices, ...(usage ? { usage } : {}) })}\n\n`;
  return chunk([{ index: 0, delta: callTool ? { role: "assistant", tool_calls: [{ index: 0, id: "call_image_read", type: "function", function: { name: "read", arguments: args } }] } : { role: "assistant", content: answer }, finish_reason: null }])
    + chunk([{ index: 0, delta: {}, finish_reason: callTool ? "tool_calls" : "stop" }])
    + chunk([], { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100, prompt_tokens_details: { cached_tokens: 800 }, completion_tokens_details: { reasoning_tokens: 20 } })
    + "data: [DONE]\n\n";
}

async function promptAndObserve(client, iterator, sessionID, api) {
  const observed = [];
  const completion = (async () => {
    for (;;) {
      const next = await iterator.next();
      if (next.done) throw new Error("V2 stream ended before execution completed");
      if (next.value.data.sessionID !== sessionID) continue;
      observed.push(next.value);
      if (["session.execution.failed", "session.execution.succeeded", "session.execution.interrupted"].includes(next.value.type)) return next.value;
    }
  })();
  // The stream may fail before the prompt HTTP response; handle both lifetimes.
  void completion.catch(() => undefined);
  await client.session.prompt({ sessionID, text: "Read the image fixture, then reply OK." }, api);
  return { terminal: await completion, observed };
}

function readToolSchema(provider, body) {
  const tool = body.tools?.find((tool) => (provider === "rehor-openai-chat" ? tool.function?.name : tool.name) === "read");
  assert.ok(tool, `${provider} did not advertise native read tool`);
  const schema = provider === "vertex" ? tool.input_schema : provider === "rehor-openai-chat" ? tool.function.parameters : tool.parameters;
  assert.equal(schema?.type, "object");
  assert.equal(schema.properties?.path?.type, "string", "V2 read tool must use path, not V1 filePath");
  assert.ok(schema.required?.includes("path"), "V2 read tool path must be required");
}
const proxyEnvironment = {
  REHOR_MODEL_PROXY_URL: "http://proxy:8450/v1",
  REHOR_MODEL_PROXY_TOKEN: "image-test-token",
};

const defaultCycle = prepared(globalConfig.opencode.model, "rehor-openai");
validateOpenCodeDeployment(defaultCycle, deployment, proxyEnvironment);
assert.equal(
  renderOpenCodeConfigForCycle(
    defaultCycle.config,
    defaultCycle.config.providerId,
    deployment,
  ).config.model,
  "rehor-openai/gpt-6-luna",
);

const instanceCycle = prepared("gpt-4.1", "rehor-openai-chat");
validateOpenCodeDeployment(instanceCycle, deployment, proxyEnvironment);
assert.equal(
  renderOpenCodeConfigForCycle(
    instanceCycle.config,
    instanceCycle.config.providerId,
    deployment,
  ).config.model,
  "rehor-openai-chat/gpt-4.1",
);

assert.throws(
  () => validateOpenCodeDeployment(defaultCycle, deployment, { REHOR_MODEL_PROXY_TOKEN: "test" }),
  /REHOR_MODEL_PROXY_URL/,
);
assert.throws(
  () =>
    validateOpenCodeDeployment(defaultCycle, deployment, {
      ...proxyEnvironment,
      REHOR_MODEL_PROXY_URL: "not a URL",
    }),
  /invalid gateway URL/,
);
assert.throws(
  () =>
    validateOpenCodeDeployment(defaultCycle, deployment, {
      ...proxyEnvironment,
      REHOR_MODEL_PROXY_URL: "http://proxy:8443/v1",
    }),
  /gateway URL must be http:\/\/<proxy-host>:8450\/v1/,
);

// Exercise V2 API, runner policy plugin, and all three adapters using localhost
// only. Preserve the deliberate HTTP 400 initialization checks, then verify a
// successful streamed tool round trip and exact usage through those same adapters.
for (const [cycle, expectedPath, expectedAuthorization] of [
  [defaultCycle, "/v1/responses", "Bearer image-test-token"],
  [instanceCycle, "/v1/chat/completions", "Bearer image-test-token"],
  [prepared("claude-sonnet-4-6", "vertex"), "/v1/projects/dummy-project/locations/dummy-region/publishers/anthropic/models/claude-sonnet-4-6:streamRawPredict", "Bearer rehor-proxy-placeholder"],
]) {
  const directory = await mkdtemp(join(tmpdir(), "rehor-provider-smoke-"));
  const requests = [];
  const marker = "image-test-provider-initialized";
  const worktree = join(directory, "worktree");
  await mkdir(worktree);
  const fixturePath = join(worktree, "image-fixture.txt");
  await writeFile(fixturePath, `${toolMarker}\n`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`provider smoke timed out: ${cycle.config.providerId}`)), 60_000);
  let supervisor;
  let client;
  let session;
  let phase = "reject";
  let successRequests = 0;
  const fixtureErrors = [];
  const server = createServer(async (request, response) => {
    try {
      let data = "";
      for await (const chunk of request) data += chunk;
      const body = JSON.parse(data);
      requests.push({ phase, path: request.url, authorization: request.headers.authorization, body });
      if (phase === "reject") {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: marker, type: "invalid_request_error" } }));
        return;
      }
      readToolSchema(cycle.config.providerId, body);
      if (successRequests > 0) assert.ok(JSON.stringify(body).includes(toolMarker), "tool output was not sent back to provider");
      assert.ok(successRequests < 2, "unexpected extra successful model step");
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(providerStream(cycle.config.providerId, cycle.config.model, successRequests++ === 0, fixturePath));
    } catch (error) {
      fixtureErrors.push(error.message);
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: error.message, type: "invalid_request_error" } }));
    }
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(cycle.config.providerId === "vertex" ? 8443 : 0, "127.0.0.1", resolve);
    });
    const rendered = renderOpenCodeConfigForCycle(
      { ...cycle.config, allowedTools: ["Read"] },
      cycle.config.providerId,
      deployment,
      { settings: {}, files: [] },
      ["claude-sonnet-4-6"],
    );
    assert.ok(Array.isArray(rendered.config.permissions), "permissions must use native V2 ordered rules");
    assert.ok(Array.isArray(rendered.config.plugins), "plugins must use native V2 configuration");
    for (const key of ["permission", "provider", "plugin", "agent", "enabled_providers", "small_model", "autoupdate"]) {
      assert.equal(Object.hasOwn(rendered.config, key), false, `renderer emitted legacy field ${key}`);
    }
    assert.equal(rendered.config.providers[cycle.config.providerId].package,
      cycle.config.providerId === "vertex" ? `aisdk:${vertexAdapterUrl.href}` : deployment.providers.find((provider) => provider.id === cycle.config.providerId).package,
      "Vertex must select the AI SDK factory protocol; OpenAI must select its native V2 package");
    supervisor = new OpenCodeServerSupervisor({
      command,
      expectedVersion: "2.1.2",
      workspaceRoot: directory,
      renderedConfig: rendered,
      passthrough: rendered.requiredEnvironment,
      base: {
        PATH: process.env.PATH,
        HOME: directory,
        XDG_CONFIG_HOME: join(directory, "original-config"),
        XDG_CACHE_HOME: join(directory, "cache"),
        XDG_DATA_HOME: join(directory, "original-data"),
        XDG_STATE_HOME: join(directory, "state"),
        REHOR_MODEL_PROXY_URL: `http://127.0.0.1:${server.address().port}/v1`,
        REHOR_MODEL_PROXY_TOKEN: "image-test-token",
        REHOR_VERTEX_PROXY_URL: "http://127.0.0.1:8443",
      },
    });
    const info = await supervisor.start(worktree, controller.signal);
    const authorization = `Basic ${Buffer.from(`opencode:${info.password}`).toString("base64")}`;
    client = OpenCode.make({ baseUrl: info.baseUrl, headers: { authorization } });
    const api = { signal: controller.signal };
    const location = { directory: worktree };
    assert.equal((await client.server.info(api)).version, "2.1.2");
    assert.equal((await client.location.get({ location }, api)).directory, worktree);
    await requireActivePolicy(client, location, controller.signal);

    const events = client.event.subscribe(api)[Symbol.asyncIterator]();
    assert.equal((await events.next()).value.type, "server.connected");
    session = await client.session.create({
      location,
      title: "Offline image smoke",
      model: { providerID: cycle.config.providerId, id: cycle.config.model },
    }, api);
    const { terminal, observed } = await promptAndObserve(client, events, session.id, api);
    assert.equal(terminal.type, "session.execution.failed");
    assert.ok(requests.length > 0, `${cycle.config.providerId} never reached localhost gateway`);
    assert.ok(requests.every((request) => request.path === expectedPath));
    assert.ok(requests.every((request) => request.authorization === expectedAuthorization));
    assert.ok(JSON.stringify(observed).includes(marker), "missing localhost gateway rejection in V2 events");
    const messages = await client.message.list({ sessionID: session.id }, api);
    assert.ok(messages.data.length > 0, "V2 persisted message projection is empty");
    await client.session.remove({ sessionID: session.id }, api);
    session = undefined;

    phase = "success";
    session = await client.session.create({ location, title: "Offline image tool and usage smoke", model: { providerID: cycle.config.providerId, id: cycle.config.model } }, api);
    const success = await promptAndObserve(client, events, session.id, api);
    assert.deepEqual(fixtureErrors, [], `invalid native provider request: ${fixtureErrors.join("; ")}`);
    assert.equal(success.terminal.type, "session.execution.succeeded", JSON.stringify(success.observed));
    assert.equal(successRequests, 2, "read tool must execute between exactly two model steps");
    assert.ok(requests.every((request) => request.path === expectedPath));
    assert.ok(requests.every((request) => request.authorization === expectedAuthorization));
    assert.ok(requests.every((request) => request.body.stream === true));
    if (cycle.config.providerId === "vertex") {
      // Vertex identifies the model in the URL, unlike OpenAI's JSON body.
      assert.ok(requests.every((request) => !Object.hasOwn(request.body, "model") && request.body.anthropic_version === "vertex-2023-10-16"));
    } else assert.ok(requests.every((request) => request.body.model === cycle.config.model));

    const toolStarted = success.observed.filter((event) => event.type === "session.tool.input.started");
    assert.equal(toolStarted.length, 1);
    assert.equal(toolStarted[0].data.name, "read");
    const toolCalled = success.observed.filter((event) => event.type === "session.tool.called");
    assert.equal(toolCalled.length, 1);
    assert.deepEqual(toolCalled[0].data.input, { path: fixturePath });
    const toolSucceeded = success.observed.filter((event) => event.type === "session.tool.success");
    assert.equal(toolSucceeded.length, 1);
    assert.equal(toolSucceeded[0].data.id, toolStarted[0].data.id);
    assert.ok(toolSucceeded[0].data.content.some((content) => content.type === "text" && content.text.includes(toolMarker)));
    assert.ok(success.observed.some((event) => event.type === "session.text.ended" && event.data.text === answer));

    const steps = success.observed.filter((event) => event.type === "session.step.ended");
    assert.equal(steps.length, 2);
    for (const step of steps) {
      assert.deepEqual(step.data.tokens, usageFor(cycle.config.providerId), "native token normalization changed");
      assert.equal(step.data.cost, 0, "unpriced custom provider native zero must not be treated as billed cost");
    }
    const infoAfter = await client.session.get({ sessionID: session.id }, api);
    const tokens = usageFor(cycle.config.providerId);
    assert.equal(infoAfter.outcome, "succeeded");
    assert.deepEqual(infoAfter.tokens, { input: tokens.input * 2, output: tokens.output * 2, reasoning: tokens.reasoning * 2, cache: { read: tokens.cache.read * 2, write: tokens.cache.write * 2 } });
    const projected = await client.message.list({ sessionID: session.id }, api);
    assert.equal(projected.data.filter((message) => message.type === "assistant").length, 2);
    assert.ok(projected.data.some((message) => message.type === "idle" && message.outcome === "succeeded"));
    assert.ok(projected.data.some((message) => message.type === "assistant" && message.content.some((part) => part.type === "tool" && part.name === "read" && part.state.status === "completed")));
    await client.session.remove({ sessionID: session.id }, api);
    session = undefined;
    console.log(`${cycle.config.providerId}: V2 rejection, streamed read tool, exact usage and persisted outcomes verified`);
    controller.abort();
    await events.return?.();
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (client && session) await client.session.remove({ sessionID: session.id }, { signal: AbortSignal.timeout(2_000) }).catch(() => undefined);
    await supervisor?.stop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

async function verifyCodeModeImage(budgetUsd, expectExceeded) {
  const directory = await mkdtemp(join(tmpdir(), "rehor-codemode-image-"));
  const worktree = join(directory, "worktree");
  await mkdir(worktree);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Code Mode image smoke timed out")), 60_000);
  const calls = [];
  const fixtureErrors = [];
  let modelSteps = 0;
  const taskInput = { external_key: "IMAGE-143", repo: "synthetic-image", summary: "Image Code Mode bridge" };
  const server = createServer(async (request, response) => {
    try {
      if (request.url === "/mcp" && request.method === "GET") {
        // Stateless Streamable HTTP fixture has no server-initiated SSE channel.
        response.writeHead(405).end();
        return;
      }
      assert.equal(request.method, "POST");
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      if (request.url === "/mcp") {
        if (body.id === undefined) {
          response.writeHead(202).end();
          return;
        }
        let result = {};
        if (body.method === "initialize") result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "image-bridge", version: "1" } };
        if (body.method === "tools/list") result = {
          tools: ["task_add", "blocked"].map((name) => ({
            name, description: `Synthetic ${name}`,
            inputSchema: { type: "object", properties: { index: { type: "integer" }, external_key: { type: "string" }, repo: { type: "string" }, summary: { type: "string" } }, required: ["index", "external_key", "repo", "summary"] },
            outputSchema: { type: "object", properties: { id: { type: "integer" }, external_key: { type: "string" } }, required: ["id", "external_key"] },
          })),
        };
        if (body.method === "tools/call") {
          calls.push({ name: body.params.name, input: body.params.arguments, sessionID: body.params._meta?.["ai.opencode/sessionID"] });
          assert.equal(body.params.name, "task_add", "denied nested tool reached MCP server");
          // Reverse completion order proves repeated calls retain separate identities.
          await delay(body.params.arguments.index === 0 ? 40 : 1);
          result = { content: [{ type: "text", text: "Unfiltered task result" }], structuredContent: { id: 143, external_key: taskInput.external_key } };
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
        return;
      }
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers.authorization, "Bearer image-test-token");
      assert.equal(body.model, "gpt-4.1");
      const names = (body.tools ?? []).map((tool) => tool.function.name);
      assert.ok(names.includes("execute"), "native default MCP Code Mode execute tool missing");
      assert.ok(!names.includes("bot-memory_task_add"), "MCP unexpectedly exposed as direct tool");
      assert.ok(modelSteps < 2, "unexpected extra Code Mode model request");
      const code = `await Promise.allSettled([
        tools["bot-memory"].task_add(${JSON.stringify({ ...taskInput, index: 0 })}),
        tools["bot-memory"].task_add(${JSON.stringify({ ...taskInput, index: 1 })}),
        tools["bot-memory"].blocked(${JSON.stringify({ ...taskInput, index: 2 })})
      ]); return "filtered";`;
      const first = modelSteps++ === 0;
      if (!first) {
        const toolMessages = body.messages.filter((message) => message.role === "tool");
        assert.ok(JSON.stringify(toolMessages).includes("filtered"));
        assert.ok(!JSON.stringify(toolMessages).includes("Unfiltered task result"), "execute did not filter nested output");
        assert.ok(!JSON.stringify(toolMessages).includes('"id":143'), "task id leaked through filtered execute output");
      }
      const delta = first ? { tool_calls: [{ index: 0, id: "call_image_execute", type: "function", function: { name: "execute", arguments: JSON.stringify({ code }) } }] } : { content: "Image Code Mode complete." };
      // Mirrors the offline fixtures: every Code Mode model step carries priced
      // tokens so the coordinator cost budget observes a positive amount. The
      // usage-only chunk must carry an empty choices array, exactly like the
      // OpenAI stream-options shape the other fixtures use.
      const chunk = (choices, usage) => `data: ${JSON.stringify({ id: "chatcmpl_bridge", object: "chat.completion.chunk", created: 1, model: "gpt-4.1", choices, ...(usage ? { usage } : {}) })}\n\n`;
      const usage = { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100, prompt_tokens_details: { cached_tokens: 800 }, completion_tokens_details: { reasoning_tokens: 20 } };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`${chunk([{ index: 0, delta, finish_reason: null }])}${chunk([{ index: 0, delta: {}, finish_reason: first ? "tool_calls" : "stop" }])}${chunk([], usage)}data: [DONE]\n\n`);
    } catch (error) {
      fixtureErrors.push(error.message);
      if (!response.headersSent) response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: error.message, type: "invalid_request_error" } }));
    }
  });
  let supervisor;
  let runtime;
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const port = server.address().port;
    const rendered = renderOpenCodeConfigForCycle({ model: "gpt-4.1", allowedTools: ["mcp__bot-memory__task_add"], openCodeMcpServers: { "bot-memory": { type: "http", url: `http://127.0.0.1:${port}/mcp` } } }, "rehor-openai-chat", deployment, {
      settings: {
        default_agent: "image-bridge",
        agents: { "image-bridge": { mode: "primary", permissions: [
          { action: "execute", resource: "*", effect: "allow" },
          { action: "bot-memory_task_add", resource: "*", effect: "allow" },
          // Discoverable in Code Mode, but denied for the real MCP resource '*'.
          { action: "bot-memory_blocked", resource: "not-the-actual-resource", effect: "allow" },
        ] } },
      }, files: [],
    });
    assert.equal(rendered.config.mcp.servers["bot-memory"].codemode, undefined, "exercise native default Code Mode, not an override");
    const base = { PATH: process.env.PATH, HOME: directory, TMPDIR: directory, XDG_CACHE_HOME: join(directory, "cache"), XDG_STATE_HOME: join(directory, "state"), REHOR_MODEL_PROXY_URL: `http://127.0.0.1:${port}/v1`, REHOR_MODEL_PROXY_TOKEN: "image-test-token" };
    supervisor = new OpenCodeServerSupervisor({ command, workspaceRoot: directory, renderedConfig: rendered, passthrough: rendered.requiredEnvironment, base });
    runtime = new OpenCodeRuntime({
      renderedConfig: rendered, base,
      supervisor: () => ({
        get info() { return supervisor.info; },
        get crashSignal() { return supervisor.crashSignal; },
        get crashError() { return supervisor.crashError; },
        stop: () => supervisor.stop(),
        start: async (path, signal) => {
          const info = await supervisor.start(path, signal);
          const client = OpenCode.make({ baseUrl: info.baseUrl, headers: { authorization: `Basic ${Buffer.from(`opencode:${info.password}`).toString("base64")}` } });
          const location = { directory: path };
          await requireActivePolicy(client, location, signal);
          const deadline = Date.now() + 10_000;
          for (;;) {
            const inventory = await client.mcp.list({ location }, { signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]) });
            const state = inventory.data.find((item) => item.name === "bot-memory")?.status;
            if (state?.status === "connected") break;
            assert.ok(!["failed", "needs_auth", "needs_client_registration"].includes(state?.status), JSON.stringify(state));
            assert.ok(Date.now() < deadline, "synthetic MCP server never connected");
            await delay(50, undefined, { signal });
          }
          // Native MCP tool registry debounces catalog updates after connection.
          await delay(200, undefined, { signal });
          return info;
        },
      }),
    });
    const input = { schemaVersion: "1", runId: `image-codemode-${expectExceeded ? "exhausted" : "generous"}`, attemptId: `image-codemode-${expectExceeded ? "exhausted" : "generous"}`, instanceId: "image-fixture", label: "image-smoke", workflowId: "image-smoke", prompt: "Execute the scripted Code Mode fixture.", task: null, runtimeId: "opencode", worktree: { path: worktree, repository: "https://example.invalid/image-fixture", snapshot: { ref: "fixture", commitSha: "fixture", dirty: false } }, instructionHash: { algorithm: "sha256", value: "1".repeat(64) }, configHash: { algorithm: "sha256", value: rendered.hash }, policyHash: { algorithm: "sha256", value: "3".repeat(64) }, provider: { id: "rehor-openai-chat", requestedModel: "rehor-openai-chat/gpt-4.1" }, limits: { timeoutMs: 45000, budgetUsd }, preflightPayloadRef: null };
    const result = await executeRun(runtime, input, { signal: controller.signal });
    assert.equal(result.error, undefined);
    assert.deepEqual(fixtureErrors, []);
    const budgetEvents = result.events.filter((event) => event.kind === "policy");
    if (expectExceeded) {
      // The first priced usage snapshot already crosses the hard limit, so the
      // run aborts with budget_exceeded after emitting the exhausted notice.
      assert.equal(result.terminal.payload.state, "failed", JSON.stringify(result.terminal));
      assert.equal(result.terminal.payload.reason, "budget_exceeded", JSON.stringify(result.terminal));
      assert.ok(budgetEvents.some((event) => event.payload.state === "exhausted" && typeof event.payload.usedUsd === "number" && event.payload.usedUsd > 0), "exhausted cost policy event missing");
      console.log(`Code Mode budgetUsd=${budgetUsd}: exhausted policy emitted, run aborted with budget_exceeded`);
      return;
    }
    assert.equal(result.terminal.payload.state, "completed", JSON.stringify(result.terminal));
    assert.equal(budgetEvents.length, 0, "generous budget must not emit cost policy events");
    assert.equal(modelSteps, 2, "wrapper or denied call incorrectly exhausted budget before final response");
    assert.equal(calls.length, 2, "both repeated nested calls must reach MCP separately");
    assert.ok(calls.every((call) => call.name === "task_add"));
    assert.deepEqual(calls.map((call) => call.input.index).sort(), [0, 1]);
    assert.ok(calls.every((call) => call.sessionID === result.terminal.runtimeSessionRef));
    const tools = result.events.filter((event) => event.kind === "tool");
    const nested = tools.filter((event) => event.payload.codeMode === true && event.payload.state === "completed");
    const successes = nested.filter((event) => event.payload.isError !== true);
    const denied = nested.filter((event) => event.payload.isError === true);
    assert.equal(new Set(successes.map((event) => event.payload.toolUseId)).size, 2);
    assert.equal(new Set(denied.map((event) => event.payload.toolUseId)).size, 1);
    assert.ok(denied.every((event) => event.payload.name === "bot-memory_blocked"));
    assert.ok(successes.every((event) => event.payload.bridgeId && event.payload.workContextAvailable === true));
    assert.ok(successes.every((event) => event.payload.content.some((part) => {
      try { return part.type === "text" && JSON.parse(part.text).id === 143; } catch { return false; }
    })), "unfiltered structured task result missing from generated bridge");
    const wrappers = tools.filter((event) => event.payload.name === "execute");
    assert.ok(wrappers.length > 0);
    assert.ok(wrappers.every((event) => event.payload.budgetUnit === "container" && event.payload.workContextAvailable === false));
    assert.ok(wrappers.some((event) => event.payload.state === "completed" && event.payload.content.includes("filtered")));
    assert.ok(wrappers.every((event) => !JSON.stringify(event.payload.content ?? "").includes("Unfiltered task result")));
    assert.equal(result.terminal.payload.context.taskId, 143);
    assert.equal(result.terminal.payload.context.externalKey, taskInput.external_key);
    assert.equal(result.terminal.payload.context.repository, taskInput.repo);
    assert.equal(result.terminal.payload.context.summary, taskInput.summary);
    assert.equal(result.terminal.payload.context.workType, "new_ticket");
    console.log(`Code Mode budgetUsd=${budgetUsd}: 2 nested successes, denied MCP blocked, filtered task 143 captured, wrapper unbudgeted; ${result.terminal.payload.state}`);
  } finally {
    clearTimeout(timer);
    controller.abort();
    await runtime?.stop();
    await supervisor?.stop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

await verifyCodeModeImage(10, false);
await verifyCodeModeImage(0.000001, true);
console.log("runner image OpenCode V2 API, active policy plugin, Responses, Chat, Vertex, tools, usage and Code Mode bridge verified");
