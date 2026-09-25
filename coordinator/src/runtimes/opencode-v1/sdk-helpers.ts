import {
  asObject,
  errorMessage,
  type JsonRecord,
  redactSensitiveText,
  stringValue,
} from "../shared";

export function record(value: unknown): JsonRecord {
  return asObject(value) ?? {};
}

export const recordOrUndefined = asObject;

export function unwrapSdkResponse(value: unknown, operation: string): unknown {
  const response = recordOrUndefined(value);
  if (response?.error !== undefined) {
    throw new Error(`${operation} failed: ${providerErrorMessage(response.error)}`);
  }
  return response && "data" in response ? response.data : value;
}

export function isTerminalAssistantMessageEntry(value: unknown, sessionId: string): boolean {
  const info = record(record(value).info);
  if (info.sessionID !== sessionId || info.role !== "assistant") return false;
  if (!recordOrUndefined(info.time)?.completed || typeof info.finish !== "string") return false;
  return info.finish !== "tool-calls" && info.finish !== "unknown";
}

export function providerErrorMessage(value: unknown): string {
  if (typeof value === "string") return redactSensitiveText(value);
  const error = record(value);
  const data = record(error.data);
  return redactSensitiveText(stringValue(data.message ?? error.message, "OpenCode session error"));
}

export function toError(value: unknown): Error {
  return value instanceof Error
    ? value
    : new Error(errorMessage(value) ?? "OpenCode cleanup failed");
}
