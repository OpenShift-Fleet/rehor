/**
 * Jira issue-field helpers shared by the obsint groomer preflights — the
 * ports of the Python `_format_ticket` field extraction (`issue.get("fields")
 * or issue`, defensive `{}.get(...)` chains). The Python formatted whatever
 * the MCP wrapper returned; the engine client returns REST-shaped issues
 * (ADF already flattened to text), so the same defensive extraction runs on
 * `fields` values that are still `unknown`.
 */
import type { JiraIssue } from "../../shared/jira.js";

/** A plain object value, or undefined — the Python `isinstance(..., dict)` checks. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A value as a string array — the Python `fields.get("labels", [])`. */
export function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/**
 * The `fields` map of a Jira issue — Python `issue.get("fields") or issue`:
 * a missing, null, or empty `fields` object falls back to the issue itself
 * (the MCP responses the Python handled could be flat).
 */
export function issueFields(issue: JiraIssue): Record<string, unknown> {
  const fields = issue.fields;
  if (fields !== undefined && Object.keys(fields).length > 0) {
    return fields as Record<string, unknown>;
  }
  return issue as unknown as Record<string, unknown>;
}

/** A field's `{name}` — the Python `fields.get(..., {}).get("name", "?")`. */
export function recordName(value: unknown): string {
  const record = asRecord(value);
  return typeof record?.name === "string" ? record.name : "?";
}

/**
 * Split labels into `repo:`-prefixed and other labels — the Python
 * `repo_labels` / `other_labels` filters (the bot's own label is excluded
 * from the displayed "labels:" line).
 */
export function splitLabels(
  labels: readonly string[],
  botLabel: string,
): { repoLabels: string[]; otherLabels: string[] } {
  const repoLabels = labels.filter((label) => label.startsWith("repo:"));
  const otherLabels = labels.filter((label) => !label.startsWith("repo:") && label !== botLabel);
  return { repoLabels, otherLabels };
}

/**
 * The description block both groomers render: clipped to 500 characters,
 * first 10 lines, indented — or the `(empty)` placeholder. The Python also
 * treated the literal strings `"null"`/`"None"` as empty (real payloads the
 * MCP wrapper produced).
 */
export function descriptionLines(description: unknown): string[] {
  const text = typeof description === "string" ? description.trim() : "";
  if (text === "" || text === "null" || text === "None") {
    return ["  description: (empty)"];
  }
  const clipped = text.length > 500 ? `${text.slice(0, 500)}...` : text;
  return [
    "  description:",
    ...clipped
      .split("\n")
      .slice(0, 10)
      .map((line) => `    ${line}`),
  ];
}

/** The `fixVersions` names of an issue — the Python `v.get("name", "?")` list. */
export function fixVersionNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const name = asRecord(entry)?.name;
    return typeof name === "string" ? name : "?";
  });
}
