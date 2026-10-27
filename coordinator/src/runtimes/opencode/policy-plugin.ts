import { OPEN_CODE_CODE_MODE_BRIDGE } from "./code-mode-bridge";

/** V2 Effect plugin. Directory policy belongs in the runner-owned global config. */
export function renderOpenCodePolicyPlugin(
  originalConfigHome: string | undefined,
  _externalDirectory: unknown,
  originalDataHome?: string,
): string {
  // JSON null represents an absent variable; an empty string remains an empty string.
  const original = {
    XDG_CONFIG_HOME: originalConfigHome ?? null,
    XDG_DATA_HOME: originalDataHome ?? null,
  };
  return `import { Cause, Effect, Exit, Semaphore, Stream } from "effect";

const original = ${JSON.stringify(original)};

export default {
  id: "rehor-policy",
  effect: (ctx) => Effect.gen(function* () {
    yield* ctx.shell.hook("create.before", (event) => Effect.sync(() => {
      // Strip runner-owned configuration/auth from this shell's environment only.
      // Local stdio MCP uses a separate native spawner and does not run this hook.
      for (const name of ["OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "OPENCODE_CONFIG_DIR", "OPENCODE_TEST_HOME", "OPENCODE_DB", "OPENCODE_AUTH_CONTENT", "OPENCODE_PASSWORD", "OPENCODE_SERVER_PASSWORD"]) {
        delete event.env[name];
      }
      for (const [name, value] of Object.entries(original)) {
        if (value === null) delete event.env[name];
        else event.env[name] = value;
      }
    }));
${OPEN_CODE_CODE_MODE_BRIDGE}
  }),
};
`;
}
