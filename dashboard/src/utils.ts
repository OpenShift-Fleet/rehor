export function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + (s % 60) + 's';
  const h = Math.floor(m / 60);
  return h + 'h ' + (m % 60) + 'm';
}

export function formatTokens(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}

const JIRA_BASE = 'https://redhat.atlassian.net/browse/';

interface SourceLike {
  source_url?: string | null;
  source_type?: string | null;
  external_key?: string | null;
}

export function sourceUrl(item: SourceLike): string | null {
  if (item.source_url) return item.source_url;
  if (!item.external_key) return null;
  if (item.source_type === 'jira') return JIRA_BASE + item.external_key;
  return null;
}

export function displayKey(item: SourceLike): string {
  return item.external_key || '';
}

/** Confirm, run a mutating fetch, alert on failure. Returns true on success.
 *  Pass null for message to skip the confirm dialog. */
export async function confirmAction(
  message: string | null,
  action: () => Promise<Response>,
): Promise<boolean> {
  if (message && !window.confirm(message)) return false;
  const res = await action();
  if (!res.ok) {
    let error = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body?.error) error = body.error;
    } catch {
      /* ignore non-JSON */
    }
    window.alert(error);
    return false;
  }
  return true;
}
