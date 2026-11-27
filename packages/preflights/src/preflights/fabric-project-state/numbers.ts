// Python-compatible JSON number guards.
//
// Python json.loads keeps "1.0"/"1e0" as floats and big integers exact, while
// JavaScript JSON.parse collapses both into Numbers that can no longer be
// serialized the way Python's json.dumps/str() would. parsePythonCompatibleJson
// records each number's original lexeme so assertNumber can reject values
// whose Python representation cannot be reproduced faithfully.

import { isRecord } from "../jira-common/shapes.js";

// Node 22.0 lacks reviver source context. Record unknown sources and reject
// them only if a number actually contributes to a Python-compatible value.
const numberSources = new WeakMap<object, Map<string, string | undefined>>();

export function parsePythonCompatibleJson(source: string): unknown {
  return JSON.parse(
    source,
    function (this: object, key: string, value: unknown, context?: { source?: string }) {
      if (typeof value === "number") {
        let sources = numberSources.get(this);
        if (!sources) {
          sources = new Map();
          numberSources.set(this, sources);
        }
        sources.set(key, context?.source);
      }
      return value;
    },
  );
}

export function assertNumber(holder: object, key: string, value: unknown): void {
  if (typeof value !== "number") return;
  const sources = numberSources.get(holder);
  const source = sources?.get(key);
  if (
    !Number.isSafeInteger(value) ||
    (sources?.has(key) && (!source || !/^-?(?:0|[1-9]\d*)$/.test(source)))
  )
    throw new Error("Unsupported Jira number representation in snapshot");
}

export function assertNumberTree(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    assertNumber(value, key, item);
    assertNumberTree(item);
  }
}

export function assertSnapshotField(issue: Record<string, unknown>, name: string): void {
  const fields = isRecord(issue.fields) ? issue.fields : undefined;
  const holder = fields && Object.hasOwn(fields, name) ? fields : issue;
  const value = holder[name];
  assertNumber(holder, name, value);
  assertNumberTree(value);
}
