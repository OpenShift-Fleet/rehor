import { CronExpressionParser } from "cron-parser";
import { configurationDiagnostic, type PreflightDiagnostic } from "./preflight-diagnostics.js";

/** One KEDA-style cron window: both expressions are evaluated in the
 * trigger's IANA timezone. */
export type ScheduleTrigger = { timezone: string; start: string; end: string };

/** Parsed `schedule:` declaration: the profile is dispatchable while any
 * trigger's window is active. */
export type ScheduleConfig = { triggers: ScheduleTrigger[] };

const TRIGGER_FIELDS = ["timezone", "start", "end"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Zod-style type name so schedule diagnostics read like preflight issues. */
function typeName(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** Standard five-field cron. cron-parser also accepts four- and six-field
 * expressions (and bare field defaults), so the field count is enforced
 * here before the parser validates the semantics. */
function isFiveFieldCron(expression: string): boolean {
  return expression.trim().split(/\s+/).length === 5;
}

/** Parse and step a declaration expression against the epoch reference
 * date: cron semantics, timezone validity, and impossible dates are
 * date-independent, so discovery never depends on the wall clock. Whatever
 * the parser rejects here would also throw during evaluation. Returns the
 * parser's failure message, or undefined when the expression is accepted. */
function cronRejection(expression: string, timezone: string): string | undefined {
  try {
    CronExpressionParser.parse(expression, { currentDate: new Date(0), tz: timezone }).next();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** KEDA cron-scaler window semantics, evaluated per cycle: a window is
 * active when the next boundary it crosses is its own end
 * (`nextEnd < nextStart`) — start inclusive, end exclusive, with overnight
 * windows falling out naturally. Triggers OR together. */
export function isScheduleActive(triggers: readonly ScheduleTrigger[], now: Date): boolean {
  for (const trigger of triggers) {
    const options = { currentDate: now, tz: trigger.timezone };
    const nextStart = CronExpressionParser.parse(trigger.start, options).next().getTime();
    const nextEnd = CronExpressionParser.parse(trigger.end, options).next().getTime();
    if (nextEnd < nextStart) return true;
  }
  return false;
}

/** Strict `schedule:` shape diagnostics for a raw declaration value: an
 * object whose only key is `triggers`, a non-empty list of objects with
 * exactly `timezone`, `start`, and `end` — valid IANA timezone, five-field
 * cron expressions, and start and end differing (identical expressions
 * define no window; KEDA rejects them too). Every issue is reported, not
 * just the first; nothing here evaluates a window. */
export function scheduleDiagnostics(value: unknown): PreflightDiagnostic[] {
  const diagnostics: PreflightDiagnostic[] = [];
  if (!isRecord(value)) {
    return [configurationDiagnostic("schedule", "invalid_type", "Invalid input: expected object with a triggers list", value)];
  }
  for (const key of Object.keys(value)) {
    if (key !== "triggers") {
      diagnostics.push(configurationDiagnostic("schedule", "unrecognized_keys", `Unrecognized key: "${key}"`, value[key]));
    }
  }
  const { triggers } = value;
  if (!Array.isArray(triggers)) {
    diagnostics.push(configurationDiagnostic("schedule.triggers", "invalid_type", "Invalid input: expected a non-empty list of triggers", triggers));
    return diagnostics;
  }
  if (triggers.length === 0) {
    diagnostics.push(configurationDiagnostic("schedule.triggers", "too_small", "Too small: expected array to have >=1 items", triggers));
    return diagnostics;
  }
  triggers.forEach((raw, index) => {
    const where = `schedule.triggers[${index}]`;
    if (!isRecord(raw)) {
      diagnostics.push(configurationDiagnostic(where, "invalid_type", "Invalid input: expected object with timezone, start, and end", raw));
      return;
    }
    for (const key of Object.keys(raw)) {
      if (!(TRIGGER_FIELDS as readonly string[]).includes(key)) {
        diagnostics.push(configurationDiagnostic(where, "unrecognized_keys", `Unrecognized key: "${key}"`, raw[key]));
      }
    }
    for (const field of TRIGGER_FIELDS) {
      const setting = raw[field];
      if (typeof setting !== "string") {
        diagnostics.push(configurationDiagnostic(`${where}.${field}`, "invalid_type", `Invalid input: expected string, received ${typeName(setting)}`, setting));
      }
    }
    const { timezone, start, end } = raw;
    // The parser's own timezone failure names the host's local clock, so a
    // fixed message carries the reason and the literal stays in `received`.
    const invalidTimezone = typeof timezone === "string" ? cronRejection("0 0 * * *", timezone) : undefined;
    if (invalidTimezone !== undefined) {
      diagnostics.push(configurationDiagnostic(`${where}.timezone`, "custom", "Invalid timezone", timezone));
    }
    if (typeof start === "string" && start === end) {
      diagnostics.push(configurationDiagnostic(where, "custom", "Invalid input: start and end must differ", start));
      return;
    }
    // Cron semantics are timezone-independent; a rejected timezone falls
    // back to UTC so one bad field never masks another.
    const zone = invalidTimezone === undefined && typeof timezone === "string" ? timezone : "UTC";
    for (const field of ["start", "end"] as const) {
      const expression = raw[field];
      if (typeof expression !== "string") continue;
      if (!isFiveFieldCron(expression)) {
        diagnostics.push(configurationDiagnostic(`${where}.${field}`, "custom", "Invalid cron expression: expected five fields", expression));
        continue;
      }
      const rejection = cronRejection(expression, zone);
      if (rejection !== undefined) {
        diagnostics.push(configurationDiagnostic(`${where}.${field}`, "custom", `Invalid cron expression: ${rejection}`, expression));
      }
    }
  });
  return diagnostics;
}
