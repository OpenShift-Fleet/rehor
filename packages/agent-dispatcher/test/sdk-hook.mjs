// Intercepts "@nvidia/openshell-sdk" for dist/gateway.js. The virtual module
// delegates to the real SDK unless a test installs an override on
// globalThis.__rehorSdkOverride, so the client-credentials flow can still be
// exercised against a mocked fetch. Unlike node:test's mock.module, this works
// with named ESM exports on Node 22. Hooks are synchronous
// (module.registerHooks); they only rewrite the one specifier.
let realSdkUrl;

export function resolve(specifier, context, nextResolve) {
  const resolved = nextResolve(specifier, context);
  if (specifier === "@nvidia/openshell-sdk") {
    realSdkUrl ??= resolved.url;
    return { url: "virtual:rehor/openshell-sdk", shortCircuit: true };
  }
  return resolved;
}

export function load(url, context, nextLoad) {
  if (url === "virtual:rehor/openshell-sdk") {
    return {
      format: "module",
      shortCircuit: true,
      source: `
        import * as real from ${JSON.stringify(realSdkUrl)};
        export const clientCredentials = (options) => (globalThis.__rehorSdkOverride?.clientCredentials ?? real.clientCredentials)(options);
        export const OpenShellClient = { connect: (options) => (globalThis.__rehorSdkOverride?.connect ?? real.OpenShellClient.connect)(options) };
      `,
    };
  }
  return nextLoad(url, context);
}
