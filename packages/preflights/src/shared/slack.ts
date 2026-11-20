/**
 * Slack webhook client for preflights that report without an AI session
 * (compact watchduty reports, weekly-status announcements).
 *
 * Webhook URLs are credentials: they arrive only through dispatcher-side
 * wiring (deployment-owned configuration), never through preflight
 * parameters or profiles. The client sends one JSON `{text}` payload per
 * call and resolves `false` on any transport failure — the Python
 * preflights warned and continued, so a failed notification degrades that
 * cycle's report instead of failing the preflight.
 */
import type { FetchLike } from "./http.js";

/** Named webhook channels; `default` backs plain `send()` calls. */
export interface SlackWebhookConfig {
  /** Webhook used by `send()`; required for any notification. */
  readonly default?: string;
  /**
   * Named overrides (e.g. `weeklyStatus`). `sendTo(channel, …)` falls back
   * to `default` when a channel is not configured — the Python
   * `WEEKLY_STATUS_SLACK_WEBHOOK_URL or SLACK_WEBHOOK_URL` behavior.
   */
  readonly channels?: Readonly<Record<string, string>>;
}

export interface SlackClientConfig {
  readonly webhooks: SlackWebhookConfig;
  /** Injectable fetch for fixture-based tests. */
  readonly fetch?: FetchLike;
  /** Request timeout in milliseconds; defaults to 10 s. */
  readonly timeoutMs?: number;
}

export interface SlackClient {
  /** Send `text` to the default webhook; `false` when unwired or failed. */
  send(text: string): Promise<boolean>;
  /**
   * Send `text` to a named channel, falling back to the default webhook
   * when the channel is not configured; `false` when neither is wired or
   * the delivery failed.
   */
  sendTo(channel: string, text: string): Promise<boolean>;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export function createSlackClient(config: SlackClientConfig): SlackClient {
  const fetchImpl: FetchLike = config.fetch ?? fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function deliver(webhook: string | undefined, text: string): Promise<boolean> {
    if (typeof webhook !== "string" || webhook.trim() === "") return false;
    try {
      const response = await fetchImpl(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  return {
    send: (text) => deliver(config.webhooks.default, text),
    sendTo: (channel, text) =>
      deliver(config.webhooks.channels?.[channel] ?? config.webhooks.default, text),
  };
}

/** Structural check used by the run-context wiring. */
export function isSlackClient(value: unknown): value is SlackClient {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.send === "function" && typeof candidate.sendTo === "function";
}
