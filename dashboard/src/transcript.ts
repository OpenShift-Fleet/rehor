export interface ParsedEntry {
  role: string;
  blockType: "text" | "thinking" | "tool_use" | "tool_result" | "error";
  label: string;
  content: string;
  isLarge: boolean;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function display(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? "";
}

function resultContent(value: unknown): string {
  return Array.isArray(value)
    ? value.map((item) => text(record(item)?.text) || display(item)).join("\n")
    : display(value);
}

function update(entry: ParsedEntry, content: string): void {
  entry.content = content;
  entry.isLarge = content.length > (entry.blockType === "text" ? 500 : 300);
}

/** Read legacy Claude messages and flattened coordinator events, independent of runtime. */
export function parseTranscript(raw: string): ParsedEntry[] {
  const entries: ParsedEntry[] = [];
  const parts = new Map<string, ParsedEntry>();
  const tools = new Map<string, { call: ParsedEntry; result?: ParsedEntry; completed: boolean }>();
  const seenEvents = new Set<string>();
  const prose = new Map<string, ParsedEntry[]>();
  const terminals: { scope: string; session: string; payload: Record<string, unknown> }[] = [];

  const add = (
    role: string,
    blockType: ParsedEntry["blockType"],
    content: string,
    label = "",
  ): ParsedEntry => {
    const entry: ParsedEntry = { role, blockType, label, content: "", isLarge: false };
    update(entry, content);
    entries.push(entry);
    return entry;
  };

  for (const line of raw.split("\n")) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const data = record(value);
    if (!data) continue;

    if ("schemaVersion" in data) {
      const payload = record(data.payload);
      if (data.schemaVersion !== "1" || !payload) continue;
      const scope = JSON.stringify([text(data.runId), text(data.attemptId)]);
      const session = text(data.runtimeSessionRef);
      const identity = (kind: string, id: string) => JSON.stringify([scope, session, kind, id]);
      const eventId = text(data.eventId);
      if (eventId) {
        const key = JSON.stringify([scope, eventId]);
        if (seenEvents.has(key)) continue;
        seenEvents.add(key);
      }

      if (data.kind === "model" && (payload.phase === "text" || payload.phase === "reasoning")) {
        const thinking = payload.phase === "reasoning";
        const partId = text(payload.partId);
        const key = partId ? identity(text(payload.phase), partId) : undefined;
        let entry = key ? parts.get(key) : undefined;
        if (!entry) {
          entry = add(thinking ? "thinking" : "assistant", thinking ? "thinking" : "text", "");
          if (key) parts.set(key, entry);
          if (!thinking) {
            const proseKey = identity("prose", "");
            const collected = prose.get(proseKey) ?? [];
            collected.push(entry);
            prose.set(proseKey, collected);
          }
        }
        // text is an authoritative snapshot; delta is only a fallback when absent.
        update(
          entry,
          typeof payload.text === "string" ? payload.text : entry.content + text(payload.delta),
        );
      } else if (data.kind === "tool") {
        if (payload.state !== "started" && payload.state !== "completed") continue;
        const aliases = [
          text(payload.partId) && identity("part", text(payload.partId)),
          text(payload.toolUseId) && identity("call", text(payload.toolUseId)),
        ].filter(Boolean);
        let tool = aliases.map((key) => tools.get(key)).find((item) => item !== undefined);
        if (!tool) {
          tool = { call: add("tool", "tool_use", ""), completed: false };
        }
        for (const key of aliases) tools.set(key, tool);
        // Replayed starts must not overwrite completed inputs/results.
        if (tool.completed && payload.state === "started") continue;
        tool.call.label = text(payload.toolName) || text(payload.name) || tool.call.label || "?";
        if (payload.input !== undefined) update(tool.call, display(payload.input));
        if (payload.state === "completed") {
          tool.completed = true;
          const content = resultContent(payload.content) || display(payload.error);
          if (content || payload.isError === true) {
            tool.result ??= add("result", "tool_result", "");
            tool.result.label = payload.isError === true ? "Error" : "";
            update(tool.result, content || "Tool failed");
          }
        }
      } else if (data.kind === "error") {
        const content =
          display(payload.message) || display(payload.error) || display(payload.reason);
        if (content.trim()) add("result", "error", content, "Error");
      } else if (data.kind === "terminal") {
        terminals.push({ scope, session, payload });
      }
      continue;
    }

    const lineType = text(data.type);
    if (["queue-operation", "last-prompt", "attachment"].includes(lineType)) continue;
    const message = record(data.message);
    if (!message) continue;
    const role = text(message.role) || lineType;
    if (typeof message.content === "string") {
      if (message.content.trim()) add(role, "text", message.content);
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    for (const value of message.content) {
      const block = record(value);
      if (!block) continue;
      if (block.type === "text" && text(block.text).trim()) {
        add(role, "text", text(block.text));
      } else if (block.type === "thinking" && text(block.thinking).trim()) {
        add("thinking", "thinking", text(block.thinking));
      } else if (block.type === "tool_use") {
        const input = record(block.input) ?? {};
        const summary = Object.entries(input)
          .slice(0, 3)
          .map(([key, value]) => `${key}=${display(value).slice(0, 60)}`)
          .join(", ");
        const entry = add("tool", "tool_use", summary, text(block.name) || "?");
        entry.isLarge = false;
      } else if (block.type === "tool_result") {
        add(
          "result",
          "tool_result",
          resultContent(block.content),
          block.is_error === true ? "Error" : "",
        );
      }
    }
  }

  // Terminal prose is a fallback. The runtime often repeats all root text here.
  const terminalDiagnostics = new Set<string>();
  for (const { scope, session, payload } of terminals) {
    const result = text(payload.resultText);
    const matching = session
      ? [prose.get(JSON.stringify([scope, session, "prose", ""])) ?? []]
      : [...prose.entries()]
          .filter(([key]) => (JSON.parse(key) as string[])[0] === scope)
          .map(([, entries]) => entries);
    const duplicate = matching.some((items) => {
      const texts = items.map((entry) => entry.content).filter((content) => content.trim());
      return (
        texts.some((content) => content.trim() === result.trim()) ||
        texts.join("").trim() === result.trim() ||
        texts.join("\n\n").trim() === result.trim()
      );
    });
    if (result.trim() && !duplicate) {
      const entry = add("assistant", "text", result);
      const key = JSON.stringify([scope, session, "prose", ""]);
      prose.set(key, [...(prose.get(key) ?? []), entry]);
    }
    const state = text(payload.state);
    const reason = display(payload.reason) || display(payload.failure) || display(payload.error);
    if (reason.trim() || (state && state !== "completed")) {
      const content = reason || `Run ${state}`;
      const key = JSON.stringify([scope, session, state, content]);
      if (!terminalDiagnostics.has(key)) {
        terminalDiagnostics.add(key);
        add("result", "error", content, state || "Error");
      }
    }
  }
  return entries.filter((entry) => entry.content.trim() || entry.blockType === "tool_use");
}
