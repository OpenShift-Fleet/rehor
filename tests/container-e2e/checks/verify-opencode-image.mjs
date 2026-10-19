import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  loadOpenCodeDeploymentConfig,
  renderOpenCodeV1ConfigForCycle,
  validateOpenCodeDeployment,
  buildOpenCodeEnvironment,
} = await import("file:///home/botuser/app/coordinator/dist/index.js");

const deployment = await loadOpenCodeDeploymentConfig();
assert.equal(Object.hasOwn(deployment, "model"), false, "shared defaults must not pin a model");
assert.equal(
  deployment.providers.find((provider) => provider.id === "rehor-openai").options.baseURL,
  "{env:REHOR_MODEL_PROXY_URL}",
);
assert.equal(
  deployment.providers.find((provider) => provider.id === "rehor-openai").options.apiKey,
  "{env:REHOR_MODEL_PROXY_TOKEN}",
);

const globalConfig = JSON.parse(await readFile("/home/botuser/app/config.json", "utf8"));
assert.equal(globalConfig.opencode.model, "gpt-6-luna");
await assert.rejects(readFile("/home/botuser/app/CLAUDE.md"), { code: "ENOENT" });

const prepared = (model, providerId) => ({
  config: {
    model,
    runtimeId: "opencode-v1",
    providerId,
    openCodeMcpServers: {},
    allowedTools: [],
    optionalMcpServers: [],
  },
});
const proxyEnvironment = {
  REHOR_MODEL_PROXY_URL: "http://proxy:8450/v1",
  REHOR_MODEL_PROXY_TOKEN: "image-test-token",
};

const defaultCycle = prepared(globalConfig.opencode.model, "rehor-openai");
validateOpenCodeDeployment(defaultCycle, deployment, proxyEnvironment);
assert.equal(
  renderOpenCodeV1ConfigForCycle(
    defaultCycle.config,
    defaultCycle.config.providerId,
    deployment,
  ).config.model,
  "rehor-openai/gpt-6-luna",
);

const instanceCycle = prepared("gpt-4.1", "rehor-openai-chat");
validateOpenCodeDeployment(instanceCycle, deployment, proxyEnvironment);
assert.equal(
  renderOpenCodeV1ConfigForCycle(
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

// Listing models does not initialize their SDKs. Exercise each bundled adapter
// offline against a local gateway that intentionally rejects inference requests.
// Reaching this gateway proves package loading succeeded without external egress.
for (const [cycle, expectedPath] of [
  [defaultCycle, "/v1/responses"],
  [instanceCycle, "/v1/chat/completions"],
]) {
  const directory = await mkdtemp(join(tmpdir(), "rehor-provider-smoke-"));
  const requests = [];
  const marker = "image-test-provider-initialized";
  const server = createServer((request, response) => {
    requests.push({ path: request.url, authorization: request.headers.authorization });
    request.resume();
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: marker, type: "invalid_request_error" } }));
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const rendered = renderOpenCodeV1ConfigForCycle(cycle.config, cycle.config.providerId, deployment);
    const configPath = join(directory, "opencode.json");
    await writeFile(configPath, JSON.stringify({
      ...rendered.config,
      small_model: rendered.config.model,
    }));
    const environment = buildOpenCodeEnvironment({
      base: {
        ...process.env,
        REHOR_MODEL_PROXY_URL: `http://127.0.0.1:${server.address().port}/v1`,
        REHOR_MODEL_PROXY_TOKEN: "image-test-token",
      },
      configDirectory: directory,
      passthrough: rendered.requiredEnvironment,
    });
    Object.assign(environment, {
      OPENCODE_CONFIG: configPath,
      OPENCODE_TEST_HOME: directory,
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      NPM_CONFIG_OFFLINE: "true",
      npm_config_offline: "true",
    });
    const output = await new Promise((resolve, reject) => {
      const child = spawn("/usr/local/bin/opencode", [
        "run", "--pure", "--print-logs", "--model", rendered.config.model,
        "Reply OK without using tools.",
      ], { cwd: directory, env: environment, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`provider smoke timed out: ${cycle.config.providerId}`));
      }, 60_000);
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", () => { clearTimeout(timer); resolve(output); });
    });
    assert.ok(requests.length > 0, `${cycle.config.providerId} never reached gateway:\n${output}`);
    assert.ok(requests.every((request) => request.path === expectedPath));
    assert.ok(requests.every((request) => request.authorization === "Bearer image-test-token"));
    assert.ok(output.includes(marker), `missing gateway rejection:\n${output}`);
    assert.ok(!output.includes("Failed to initialize provider"), output);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

console.log("runner image OpenCode defaults and offline provider initialization verified");
