// Registers the SDK interception hooks before any test file loads.
// node:test's mock.module cannot provide named ESM exports on Node 22 (the
// production runtime), so the SDK is intercepted with standard module hooks
// instead. Registered via `node --import` so it applies to every test process.
import { registerHooks } from "node:module";

registerHooks(await import("./sdk-hook.mjs"));
