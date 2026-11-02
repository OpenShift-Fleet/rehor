// Shared URL acceptance checks for configured endpoints: parseable,
// HTTPS-only, and no userinfo, query, or fragment. This stops credentials
// or extra request context from being smuggled through a configured URL.
// Callers with stricter needs (for example an origin-only gateway endpoint)
// layer their own checks on the returned URL.
export function parseHttpsUrl(value: string, label: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${label} is not a valid URL`); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must be HTTPS without userinfo, query, or fragment`);
  }
  return url;
}
