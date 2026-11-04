/** Untrusted runtime/bridge output is classified, never forwarded verbatim.
 * Even an ERROR line or Error.message can contain a complete model request.
 */
export function classifyDiagnostic(text: string): string | undefined {
  const classes: string[] = [];
  const signatures: readonly [RegExp, string][] = [
    [
      /ProviderInitError|InitError|Failed to initialize provider/i,
      "provider initialization failed",
    ],
    [/Cannot find (?:package|module)|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/i, "module not found"],
    [
      /ENOTCACHED|cache miss|offline.*(?:package|npm)|cache mode is ['"]only-if-cached['"] but no cached response is available/i,
      "offline package cache miss",
    ],
    [/NpmInstallFailedError/i, "dependency install failed"],
    [
      /OpenCodeWorkspaceOwnershipError|OpenCode worktree path [^\r\n]+ is owned by UID \d+, expected \d+/i,
      "workspace ownership mismatch",
    ],
    [/ECONNREFUSED|connection refused/i, "connection refused"],
    [/ENOTFOUND|EAI_AGAIN/i, "DNS lookup failed"],
    [/ETIMEDOUT|TimeoutError|timed out/i, "operation timed out"],
    [/EACCES|EPERM|permission denied/i, "permission denied"],
    [/ENOENT/i, "file not found"],
    [/Unauthorized|AuthenticationError|\b401\b/i, "authentication failed"],
    [/Forbidden|\b403\b/i, "access forbidden"],
    [/RateLimitError|\b429\b/i, "rate limited"],
    [
      /ConfigInvalidError|invalid configuration|fatal startup configuration/i,
      "invalid configuration",
    ],
    [/fatal startup timeout/i, "startup timeout"],
  ];
  for (const [pattern, label] of signatures) {
    if (pattern.test(text) || text.includes(label)) classes.push(label);
  }
  // Package identifiers are selected from a fixed list, not user-controlled text.
  for (const match of text.matchAll(
    /@(?:ai-sdk\/openai(?:-compatible)?|opencode-ai\/plugin)(?=[^A-Za-z0-9_/-]|$)/g,
  )) {
    classes.push(`package=${match[0]}`);
  }
  // OpenCode 1.18.29 uses timestamp=... level=ERROR ... logfmt records,
  // in addition to severity-prefixed output. Only inspect the severity token;
  // an unknown message/error field must never be forwarded verbatim.
  const severity =
    /^(ERROR|FATAL|WARN(?:ING)?)\b|(?:^|\s)level=(ERROR|FATAL|WARN(?:ING)?)(?=\s|$)/i.exec(text);
  if (!classes.length && severity) {
    const level = (severity[1] ?? severity[2] ?? "").toUpperCase();
    classes.push(
      level.startsWith("WARN")
        ? "unclassified runtime warning (payload suppressed)"
        : "unclassified runtime error (payload suppressed)",
    );
  }
  return classes.length ? classes.join("; ") : undefined;
}

/** Read only known causal slots; no request/response/body/metadata serialization. */
export function providerDiagnostic(value: unknown): string {
  const seen = new Set<unknown>();
  const parts: string[] = [];
  const visit = (entry: unknown, depth: number): void => {
    if (depth >= 8 || seen.has(entry)) return;
    seen.add(entry);
    if (typeof entry === "string") {
      const classified = classifyDiagnostic(entry);
      if (classified) parts.push(classified);
      return;
    }
    if (typeof entry !== "object" || entry === null) return;
    const object = entry as Record<string, unknown>;
    for (const key of ["name", "message", "code", "statusCode"]) {
      const field = object[key];
      if (typeof field === "string" || typeof field === "number") visit(String(field), depth + 1);
    }
    visit(object.cause, depth + 1);
    visit(object.data, depth + 1);
  };
  visit(value, 0);
  return [...new Set(parts)].join("; ") || "unclassified runtime error (payload suppressed)";
}

/** Preserve causal classification and stack locations, excluding provider messages. */
export function runtimeErrorDetails(value: unknown): string {
  const seen = new Set<unknown>();
  const parts: string[] = [];
  let current = value;
  for (let depth = 0; depth < 8 && current !== undefined; depth++) {
    if (seen.has(current)) {
      parts.push("[cyclic cause]");
      break;
    }
    seen.add(current);
    parts.push(providerDiagnostic(current));
    if (!(current instanceof Error)) break;
    // Only source locations; stack headers can contain prompts or response bodies.
    for (const line of (current.stack ?? "").split("\n").slice(1, 17)) {
      const location = /(?:\(|\s)((?:file:\/\/|\/|node:)[^\s()]+:\d+:\d+)\)?$/.exec(line);
      if (location) parts.push(`    at ${location[1]}`);
    }
    current = current.cause;
  }
  return parts.join("\nCaused by: ");
}
