import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const {
  loadOpenCodeDeploymentConfig,
  renderOpenCodeV1ConfigForCycle,
  validateOpenCodeDeployment,
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

console.log("runner image OpenCode defaults verified");
