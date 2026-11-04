/** Generated native Effect-plugin bridge for OpenCode V2.1.2.
 * Effect is supplied by the native plugin host, requiring no configured package.
 * Raw Code Mode fetch remains independent of webfetch permissions. Native fetch
 * rows stay in metadata.toolCalls; this bridge records registered tools only.
 */
export interface OpenCodeCodeModeCall {
  id: string;
  name: string;
  input?: unknown;
  status: "running" | "completed" | "error";
  content?: unknown[];
  error?: string;
}

export interface OpenCodeCodeModeEvidence {
  calls: OpenCodeCodeModeCall[];
}

export const OPEN_CODE_CODE_MODE_BRIDGE = `
    const executions = new Map();
    const key = (event) => JSON.stringify([event.sessionID, event.messageID, event.id]);
    // Detached JSON snapshots: later tool/input mutations cannot rewrite history.
    // Do not truncate or redact here: work-context needs the unfiltered result.
    const json = (value) => {
      if (value === undefined) return undefined;
      try { return JSON.parse(JSON.stringify(value)); }
      catch { return { rehorCaptureError: "Tool evidence is not JSON serializable" }; }
    };
    const errorText = (error) => {
      try { return typeof error?.message === "string" ? error.message : String(error); }
      catch { return "Tool failed"; }
    };
    const snapshot = (execution) => ({ calls: execution.calls.map(({ row }) => json(row)) });
    const resultContent = (result) => {
      const captured = json(result.content);
      const content = typeof result.content === "string"
        ? [{ type: "text", text: result.content }]
        : Array.isArray(captured) ? captured : [];
      // Structured MCP output may contain the task ID omitted from its text.
      if (result.output !== undefined) {
        const text = JSON.stringify(json(result.output));
        if (text !== undefined && !content.some((part) => part.type === "text" && part.text === text))
          content.push({ type: "text", text });
      }
      return content;
    };
    const completed = (entry, result) => {
      entry.row.status = result.metadata?.error === true || result.metadata?.isError === true
        ? "error" : "completed";
      entry.row.content = resultContent(result);
    };
    const failed = (entry, error) => {
      entry.row.status = "error";
      entry.row.error = errorText(error);
    };

    yield* ctx.tool.hook("execute.before", (event) => Effect.withFiber((fiber) => Effect.sync(() => {
      const id = key(event);
      if (event.tool === "execute") {
        executions.set(id, { sessionID: event.sessionID, calls: [], active: new Map(), lock: Semaphore.makeUnsafe(1) });
        return;
      }
      const execution = executions.get(id);
      if (!execution) return;
      const index = execution.calls.length;
      const entry = {
        row: {
          id: event.sessionID + ":" + event.messageID + ":" + event.id + ":nested:" + index,
          name: event.tool,
          input: json(event.input),
          status: "running",
        },
      };
      execution.calls.push(entry);
      // V2 before -> input decoding -> executor -> output encoding -> after run
      // in the same native fiber, including asynchronous schema validation.
      execution.active.set(fiber.id, entry);
    })));

    yield* ctx.tool.transform((editor) => {
      for (const registered of editor.list()) {
        if (registered.options?.codemode === false) continue;
        editor.update(registered.id, (tool) => {
          const execute = tool.execute;
          tool.execute = (input, context) => Effect.withFiber((fiber) => {
            const execution = executions.get(key(context));
            if (!execution) return execute(input, context);
            const entry = execution.active.get(fiber.id);
            if (!entry) return execute(input, context);
            // Serial replacement snapshots prevent parallel calls publishing stale
            // running rows after newer completions. Progress must not mask a tool's
            // result, permission rejection, or cancellation.
            const publish = () => execution.lock.withPermit(
              Effect.suspend(() => context.progress({ rehorCodeMode: snapshot(execution) }))
            ).pipe(Effect.catchCause(() => Effect.void));
            execution.publish = publish;
            // Preserve typed failures, defects and interruption without converting
            // native execution through a Promise adapter. Only after may succeed.
            return Effect.andThen(publish(), Effect.suspend(() => execute(input, context))).pipe(
              Effect.onExit((exit) => Effect.andThen(
                Effect.sync(() => {
                  if (Exit.isFailure(exit)) failed(entry, Cause.squash(exit.cause));
                }),
                publish()
              ))
            );
          });
        });
      }
    });

    yield* ctx.tool.hook("execute.after", (event) => Effect.withFiber((fiber) => Effect.gen(function* () {
      const id = key(event);
      const execution = executions.get(id);
      if (!execution) return;
      if (event.tool !== "execute") {
        // Validation errors and tools registered after this transform still have
        // native hooks. Preserve their final evidence even without a wrapper.
        const entry = execution.active.get(fiber.id);
        if (entry) {
          execution.active.delete(fiber.id);
          if (event.status === "completed") completed(entry, event.result);
          else failed(entry, event.error);
          if (execution.publish) yield* execution.publish();
        }
        return;
      }
      try {
        for (const entry of execution.calls) {
          if (entry.row.status === "running") failed(entry, new Error("Code Mode call interrupted"));
        }
        const target = event.status === "completed" ? event.result : event.error;
        // Native V2 supplies Tool.Error, but malformed hook payloads and immutable
        // errors must not turn the original outcome into a plugin failure.
        let attached = false;
        try {
          if (target !== null && typeof target === "object" && !Object.isFrozen(target)) {
            attached = Reflect.set(target, "metadata", { ...target.metadata, rehorCodeMode: snapshot(execution) });
          }
        } catch { /* Non-writable metadata, accessors and proxies use progress instead. */ }
        if (!attached && execution.publish) yield* execution.publish();
      } finally {
        executions.delete(id);
      }
    })));

    // An interrupted execution can skip execute.after. Also release state when
    // admission fails in a later hook or the plugin unloads.
    yield* ctx.event.subscribe().pipe(
      Stream.runForEach((event) => Effect.sync(() => {
        if (!["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted", "session.removed"].includes(event.type)) return;
        for (const [id, execution] of executions) {
          if (execution.sessionID === event.data.sessionID) executions.delete(id);
        }
      })),
      Effect.ensuring(Effect.sync(() => executions.clear())),
      Effect.forkScoped({ startImmediately: true })
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => executions.clear()));
`;
