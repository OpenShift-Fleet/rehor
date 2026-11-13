import test from "node:test";
import assert from "node:assert/strict";
import { createKubernetesSecretReader, SECRET_TIER_LABEL, TIER_ONE_SECRET_NAME } from "../dist/kubernetes-secrets.js";
import { SecretRenderError } from "../dist/secret-rendering.js";

const namespace = "platform-frontend-ai-dev-stage";
const token = "projected-service-account-token";
const serviceAccountDirectory = "/var/run/secrets/kubernetes.io/serviceaccount";

function secretBody({ name = "slack-webhook", labels = { [SECRET_TIER_LABEL]: "2" }, data = { url: "https://hooks.example/XYZ" }, namespace: secretNamespace = namespace, kind = "Secret" } = {}) {
  return JSON.stringify({
    kind,
    apiVersion: "v1",
    metadata: { name, namespace: secretNamespace, labels },
    type: "Opaque",
    data: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, Buffer.from(value, "utf8").toString("base64")])),
  });
}

/** Reader fixture with projected service-account files and a scripted http. */
function fixture(respond) {
  const requests = [];
  const files = new Map([
    [`${serviceAccountDirectory}/token`, Buffer.from(`${token}\n`)],
    [`${serviceAccountDirectory}/ca.crt`, Buffer.from("ca-certificate-bytes")],
    [`${serviceAccountDirectory}/namespace`, Buffer.from(`${namespace}\n`)],
  ]);
  const reader = createKubernetesSecretReader({
    env: { KUBERNETES_SERVICE_HOST: "kubernetes.example", KUBERNETES_SERVICE_PORT_HTTPS: "443" },
    readFile: async (path) => {
      const file = files.get(path);
      if (file === undefined) throw new Error("missing file");
      return file;
    },
    http: async (request) => {
      requests.push(request);
      return respond(request);
    },
  });
  return { reader, requests, files };
}

const assertFails = (promise, failure, category, leaked = []) =>
  assert.rejects(promise, (error) => {
    assert.ok(error instanceof SecretRenderError, `expected SecretRenderError, got ${error}`);
    assert.equal(error.failure, failure);
    if (category) assert.equal(error.category, category);
    for (const value of leaked) assert.ok(!error.message.includes(value), `error message leaked ${value}`);
    return true;
  });

test("reads a tier-2 Secret with the automounted token and decodes its data", async () => {
  const { reader, requests } = fixture(() => ({ status: 200, body: secretBody() }));
  const data = await reader("slack-webhook");
  assert.deepEqual([...data.entries()], [["url", Buffer.from("https://hooks.example/XYZ", "utf8")]]);
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.equal(request.url.href, `https://kubernetes.example/api/v1/namespaces/${namespace}/secrets/slack-webhook`);
  assert.equal(request.method, "GET");
  assert.equal(request.headers.authorization, `Bearer ${token}`);
  assert.equal(request.headers.accept, "application/json");
  assert.equal(request.readResponseBody, true);
  assert.deepEqual(request.ca, Buffer.from("ca-certificate-bytes"));
});

test("tier-1 devbot-secrets is denied before any request", async () => {
  const { reader, requests } = fixture(() => ({ status: 200, body: secretBody() }));
  await assertFails(reader(TIER_ONE_SECRET_NAME), "tier", "authorization", [token]);
  assert.deepEqual(requests, []);
});

test("secrets without the tier-2 label are denied", async () => {
  for (const labels of [{}, { [SECRET_TIER_LABEL]: "1" }, { [SECRET_TIER_LABEL]: "3" }]) {
    const { reader } = fixture(() => ({ status: 200, body: secretBody({ labels }) }));
    await assertFails(reader("slack-webhook"), "tier", "authorization");
  }
  // A Secret with no labels key at all is denied the same way. secretBody()
  // defaults cannot express this: passing labels: undefined restores the
  // tier-2 default through destructuring.
  const unclassified = fixture(() => ({
    status: 200,
    body: JSON.stringify({
      kind: "Secret",
      apiVersion: "v1",
      metadata: { name: "slack-webhook", namespace },
      type: "Opaque",
      data: { url: Buffer.from("https://hooks.example/XYZ", "utf8").toString("base64") },
    }),
  }));
  await assertFails(unclassified.reader("slack-webhook"), "tier", "authorization");
});

test("a missing Secret is a missing-secret failure", async () => {
  const { reader, requests } = fixture(() => ({ status: 404, body: JSON.stringify({ kind: "Status", code: 404 }) }));
  await assertFails(reader("absent"), "missing-secret", "configuration");
  assert.equal(requests.length, 1);
});

test("authorization and transport failures carry fixed categories", async () => {
  const cases = [
    [{ status: 403, body: "" }, "transport", "authorization"],
    [{ status: 401, body: "" }, "transport", "authorization"],
    [{ status: 500, body: "" }, "transport", "response"],
    [{ status: 200, body: "not json" }, "transport", "response"],
  ];
  for (const [response, failure, category] of cases) {
    const { reader } = fixture(() => response);
    await assertFails(reader("slack-webhook"), failure, category);
  }
  const network = fixture(() => {
    throw new Error("connect ECONNREFUSED kubernetes.example");
  });
  await assertFails(network.reader("slack-webhook"), "transport", "network", ["ECONNREFUSED"]);
});

test("malformed Secret responses fail closed", async () => {
  const cases = [
    secretBody({ name: "other-secret" }),
    secretBody({ namespace: "other-namespace" }),
    secretBody({ kind: "ConfigMap" }),
    JSON.stringify({ kind: "Secret", metadata: { name: "slack-webhook", namespace, labels: { [SECRET_TIER_LABEL]: "2" } }, data: { url: "not base64!" } }),
    JSON.stringify({ kind: "Secret", metadata: { name: "slack-webhook", namespace, labels: { [SECRET_TIER_LABEL]: "2" } }, data: { url: 7 } }),
    JSON.stringify({ kind: "Secret", metadata: { name: "slack-webhook", namespace, labels: { [SECRET_TIER_LABEL]: "2" } }, data: [] }),
  ];
  for (const body of cases) {
    const { reader } = fixture(() => ({ status: 200, body }));
    await assertFails(reader("slack-webhook"), "transport", "response");
  }
});

test("a Secret with no data decodes to an empty payload", async () => {
  const { reader } = fixture(() => ({ status: 200, body: secretBody({ data: {} }) }));
  assert.deepEqual([...(await reader("slack-webhook")).entries()], []);
  const absent = fixture(() => ({
    status: 200,
    body: JSON.stringify({ kind: "Secret", metadata: { name: "slack-webhook", namespace, labels: { [SECRET_TIER_LABEL]: "2" } } }),
  }));
  assert.deepEqual([...(await absent.reader("slack-webhook")).entries()], []);
});

test("invalid Secret names are rejected before any request or URL is built", async () => {
  const { reader, requests } = fixture(() => ({ status: 200, body: secretBody() }));
  for (const name of ["../devbot-secrets", "UPPER", "a b", "a/b", "", "x".repeat(254), "secret-name-with-trailing-dot."]) {
    await assertFails(reader(name), "invalid-reference", "configuration");
  }
  assert.deepEqual(requests, []);
});

test("missing projected credentials or API configuration fail closed", async () => {
  const missing = createKubernetesSecretReader({
    env: { KUBERNETES_SERVICE_HOST: "kubernetes.example" },
    readFile: async () => {
      throw new Error("ENOENT");
    },
    http: async () => ({ status: 200, body: secretBody() }),
  });
  await assertFails(missing("slack-webhook"), "transport", "credentials");

  const noHost = createKubernetesSecretReader({
    env: {},
    readFile: async (path) => Buffer.from(path.endsWith("/namespace") ? namespace : "x"),
    http: async () => ({ status: 200, body: secretBody() }),
  });
  await assertFails(noHost("slack-webhook"), "transport", "configuration");

  const badNamespace = fixture(() => ({ status: 200, body: secretBody() }));
  badNamespace.files.set(`${serviceAccountDirectory}/namespace`, Buffer.from("Not A Namespace\n"));
  await assertFails(badNamespace.reader("slack-webhook"), "transport", "credentials");
});
