import { createHash } from "node:crypto";
import { pyTruthy } from "../jira-common/shapes.js";
import { mcpCustomField } from "./mcp.js";
import {
  assertNumber,
  assertNumberTree,
  assertSnapshotField,
  parsePythonCompatibleJson,
} from "./numbers.js";

export type RecordData = Record<string, unknown>;
export const record = (value: unknown): RecordData | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordData)
    : undefined;
export const text = (value: unknown): string => (typeof value === "string" ? value : "");
export const field = (issue: RecordData, name: string): unknown => {
  const fields = record(issue.fields);
  return fields && Object.hasOwn(fields, name) ? fields[name] : issue[name];
};
export const keyOf = (issue: unknown): string =>
  text(issue) || text(record(issue)?.key) || text(record(issue)?.issue_key);
export const parentKey = (issue: RecordData): string =>
  keyOf(field(issue, "parent")) || keyOf(field(issue, "epic_key"));
export const statusName = (issue: RecordData): string => {
  const status = field(issue, "status");
  if (status == null) return "";
  const name = record(status) ? record(status)?.name : status;
  if (typeof name !== "string") throw new Error("Invalid Jira status");
  return name;
};
export const labels = (issue: RecordData): string[] => {
  const value = field(issue, "labels");
  if (!Array.isArray(value) || value.some((label) => typeof label !== "string")) {
    throw new Error(`Missing or invalid Jira labels on ${keyOf(issue)}`);
  }
  return value;
};

export const COORD_STATES = new Set(
  ["needs-plan", "active", "blocked", "complete"].map((state) => `dev-bot-coordinator:${state}`),
);

// Number guards moved to numbers.ts (shared with the mcp-atlassian ports);
// re-exported because tests and sibling modules import them from here.
export { assertNumber, assertNumberTree, assertSnapshotField, parsePythonCompatibleJson };

function decodedContainer(value: string): unknown {
  if (!/^[{[]/.test(value.trimStart())) return undefined;
  try {
    return parsePythonCompatibleJson(value);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return undefined;
  }
}

function extractTeam(raw: unknown, allowScalar = true): string {
  if (Array.isArray(raw)) {
    const ids = new Set(
      raw
        .map((item, index) => {
          assertNumber(raw, String(index), item);
          return extractTeam(item, false);
        })
        .filter(Boolean),
    );
    return ids.size === 1 ? [...ids][0] : "";
  }
  const obj = record(raw);
  if (obj) {
    for (const name of ["id", "teamId", "team_id", "teamID"]) {
      const item = obj[name];
      // Python accepts any non-None, non-dict/list scalar and str()s it.
      if (item === null || item === undefined || typeof item === "object") continue;
      assertNumber(obj, name, item);
      const id = pythonString(item).trim();
      if (id) return id;
    }
    for (const name of ["team", "option", "value", "data"]) {
      const item = obj[name];
      if (typeof item === "number") assertNumber(obj, name, item);
      const id =
        record(item) || Array.isArray(item)
          ? extractTeam(item, false)
          : typeof item === "number" || /^[A-Za-z0-9_-]+$/.test(text(item).trim())
            ? String(item).trim()
            : "";
      if (id) return id;
    }
    return "";
  }
  if (typeof raw === "number") return String(raw);
  if (typeof raw !== "string") return "";
  const decoded = decodedContainer(raw);
  if (record(decoded) || Array.isArray(decoded)) return extractTeam(decoded, false);
  return allowScalar ? raw.trim() : "";
}

export const teamId = (issue: RecordData, fieldId: string): string => {
  const fields = record(issue.fields);
  const holder = fields && Object.hasOwn(fields, fieldId) ? fields : issue;
  assertNumber(holder, fieldId, holder[fieldId]);
  // The Fabric Python reads team fields from mcp-atlassian 0.23.1 output,
  // where every customfield_* value arrives wrapped as {"value": processed}
  // (select-like option ids are discarded). Emulating that wrapper makes a
  // REST read digest identically; already-simplified MCP shapes pass through
  // the same wrapper unchanged.
  return extractTeam(mcpCustomField(holder[fieldId]));
};

function codePointCompare(a: string, b: string): number {
  const left = [...a],
    right = [...b];
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const diff = (left[i].codePointAt(0) ?? 0) - (right[i].codePointAt(0) ?? 0);
    if (diff) return diff;
  }
  return left.length - right.length;
}

export const sorted = (items: Iterable<string>): string[] => [...items].sort(codePointCompare);

// Python json.dumps(..., sort_keys=True, ensure_ascii=True, separators=(",", ":"))
// for JSON data. JS numbers have already lost Python's int/float distinction.
export function pythonJson(value: unknown, spaced = false): string {
  const comma = spaced ? ", " : ",";
  const colon = spaced ? ": " : ":";
  if (typeof value === "string") {
    return JSON.stringify(value).replace(
      /[\u007f-\uffff]/g,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
  }
  if (Array.isArray(value)) return `[${value.map((item) => pythonJson(item, spaced)).join(comma)}]`;
  const obj = record(value);
  if (obj)
    return `{${sorted(Object.keys(obj))
      .map((key) => `${pythonJson(key)}${colon}${pythonJson(obj[key], spaced)}`)
      .join(comma)}}`;
  if (typeof value === "number" && !Number.isSafeInteger(value))
    throw new Error("Unsupported number in Jira snapshot");
  return JSON.stringify(value ?? null);
}

// Python str() is used by the legacy plan snapshot, including for ADF objects.
export function pythonString(value: unknown): string {
  function repr(item: unknown): string {
    if (typeof item === "string") {
      const quote = item.includes("'") && !item.includes('"') ? '"' : "'";
      const escaped = [...item]
        .map((char) => {
          if (char === "\\" || char === quote) return `\\${char}`;
          if (char === "\n") return "\\n";
          if (char === "\r") return "\\r";
          if (char === "\t") return "\\t";
          if (char !== " " && /[\p{C}\p{Z}]/u.test(char)) {
            const code = char.codePointAt(0) ?? 0;
            const width = code <= 0xff ? 2 : code <= 0xffff ? 4 : 8;
            return `\\${width === 2 ? "x" : width === 4 ? "u" : "U"}${code.toString(16).padStart(width, "0")}`;
          }
          return char;
        })
        .join("");
      return quote + escaped + quote;
    }
    if (item === null || item === undefined) return "None";
    if (typeof item === "boolean") return item ? "True" : "False";
    if (Array.isArray(item)) return `[${item.map(repr).join(", ")}]`;
    const obj = record(item);
    if (obj) {
      // JavaScript reorders array-index keys, whereas Python preserves input order.
      if (Object.keys(obj).some((key) => /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < 0xffffffff))
        throw new Error("Unsupported numeric object key in Jira description");
      return `{${Object.entries(obj)
        .map(([key, val]) => `${repr(key)}: ${repr(val)}`)
        .join(", ")}}`;
    }
    if (typeof item === "number" && !Number.isSafeInteger(item))
      throw new Error("Unsupported number in Jira description");
    return String(item);
  }
  return typeof value === "string" ? value : repr(value);
}

const unassigned = new Set(["", "unassigned", "unassigned user"]);
export function isAssigned(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return !unassigned.has(value.trim().toLowerCase());
  if (Array.isArray(value)) return value.some(isAssigned);
  const obj = record(value);
  if (obj) {
    const identifiers = ["accountId", "account_id", "name", "key", "username", "emailAddress", "id"]
      .map((key) => obj[key])
      .filter(
        (item) => (typeof item === "string" || typeof item === "number") && String(item).trim(),
      );
    if (identifiers.length)
      return identifiers.some((item) => !unassigned.has(String(item).trim().toLowerCase()));
    if (
      ["displayName", "display_name"].some(
        (key) =>
          typeof obj[key] === "string" && unassigned.has((obj[key] as string).trim().toLowerCase()),
      )
    )
      return false;
    for (const key of ["value", "user", "assignee"])
      if (obj[key] != null) return isAssigned(obj[key]);
    return pyTruthy(obj);
  }
  return pyTruthy(value);
}

function commentBody(raw: unknown): string {
  if (raw != null && typeof raw !== "string" && typeof raw !== "object")
    throw new Error("Invalid Jira comment body");
  const decoded = typeof raw === "string" ? decodedContainer(raw) : undefined;
  if (typeof raw === "string" && !record(decoded) && !Array.isArray(decoded)) return raw;
  const body = decoded ?? raw ?? "";
  const parts: string[] = [];
  function collect(node: unknown): void {
    if (Array.isArray(node)) {
      node.forEach(collect);
      return;
    }
    const item = record(node);
    if (!item) return;
    if (item.type === "text") {
      parts.push(text(item.text));
      return;
    }
    const attrs = record(item.attrs);
    if (item.type === "mention") {
      parts.push(text(attrs?.text));
      return;
    }
    if (item.type === "codeBlock") {
      const language = text(attrs?.language);
      parts.push(`\`\`\`${/^[A-Za-z0-9_-]+$/.test(language) ? language : ""}\n`);
      if (Array.isArray(item.content)) collect(item.content);
      parts.push("\n```\n");
      return;
    }
    if (Array.isArray(item.content)) collect(item.content);
    else parts.push(text(item.text));
    if (["paragraph", "heading", "listItem", "blockquote"].includes(text(item.type)))
      parts.push("\n");
  }
  collect(body);
  const flattened = parts.join("").trim();
  if (flattened) return flattened;
  assertNumberTree(body);
  return pythonJson(body, true);
}

export function humanComments(comments: readonly RecordData[]) {
  return comments.flatMap((comment) => {
    const body = commentBody(comment.body);
    const lines = body
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Python str.splitlines() boundaries, kept for fingerprint parity.
      .split(/[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (
      /^(?:coordinator update)(?:$| -)/i.test(lines[0]?.replace(/^#+/, "").trim() ?? "") ||
      lines.slice(-2).some((line) => line.startsWith("Coordinator action:"))
    )
      return [];
    assertNumber(comment, "id", comment.id);
    return [{ id: String(comment.id || ""), body, created: comment.created ?? null }];
  });
}

export function fingerprint(
  parent: RecordData,
  control: RecordData,
  children: readonly RecordData[],
  teamFieldId: string,
  comments: ReturnType<typeof humanComments>,
  pullRequests: unknown = {},
) {
  const payload = {
    parent: {
      key: keyOf(parent),
      summary: field(parent, "summary"),
      description: field(parent, "description"),
      status: statusName(parent),
    },
    control: {
      key: keyOf(control),
      summary: field(control, "summary"),
      description: field(control, "description"),
      parent: parentKey(control),
      team: teamId(control, teamFieldId),
      labels: sorted(labels(control).filter((label) => !COORD_STATES.has(label))),
      comments: comments.map(({ id, body }) => ({ id, body })),
    },
    children: [...children]
      .sort((a, b) => codePointCompare(keyOf(a), keyOf(b)))
      .map((child) => ({
        key: keyOf(child),
        summary: field(child, "summary"),
        description: field(child, "description"),
        updated: field(child, "updated"),
        status: statusName(child),
        team: teamId(child, teamFieldId),
        priority: field(child, "priority"),
        issue_type: pyTruthy(field(child, "issuetype"))
          ? field(child, "issuetype")
          : field(child, "issue_type"),
        labels: sorted(labels(child)),
        links: field(child, "issuelinks") ?? [],
        assignee: isAssigned(field(child, "assignee")),
      })),
    open_pull_requests: pullRequests,
  };
  return createHash("sha256").update(pythonJson(payload)).digest("hex");
}
