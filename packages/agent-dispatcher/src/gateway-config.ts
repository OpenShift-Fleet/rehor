export type GatewayConfig = {
  endpoint: string;
  name: string;
  issuer: string;
  clientId: string;
  audience: string;
  clientSecret: string;
  subject?: string;
};

const keys = ["OPENSHELL_GATEWAY_ENDPOINT", "OPENSHELL_GATEWAY_NAME", "OPENSHELL_OIDC_ISSUER", "OPENSHELL_CLIENT_ID", "OPENSHELL_OIDC_AUDIENCE", "OPENSHELL_OIDC_CLIENT_SECRET", "OPENSHELL_SERVICE_ACCOUNT_SUBJECT"] as const;

function httpsUrl(value: string, originOnly = false): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Invalid gateway configuration"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
      || (originOnly && url.pathname !== "/")) throw new Error("Invalid gateway configuration");
  return url.toString().replace(/\/$/, "");
}

export function readGatewayConfig(env: NodeJS.ProcessEnv): GatewayConfig | undefined {
  if (!keys.some((key) => env[key] !== undefined)) return undefined;
  const required = keys.slice(0, 6).map((key) => env[key]);
  const subject = env.OPENSHELL_SERVICE_ACCOUNT_SUBJECT;
  if (required.some((value) => !value || !value.trim() || value.trim() !== value) || (subject !== undefined && (!subject.trim() || subject.trim() !== subject)) || env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new Error("Invalid gateway configuration");
  }
  return {
    endpoint: httpsUrl(env.OPENSHELL_GATEWAY_ENDPOINT!, true),
    name: env.OPENSHELL_GATEWAY_NAME!,
    issuer: httpsUrl(env.OPENSHELL_OIDC_ISSUER!),
    clientId: env.OPENSHELL_CLIENT_ID!,
    audience: env.OPENSHELL_OIDC_AUDIENCE!,
    clientSecret: env.OPENSHELL_OIDC_CLIENT_SECRET!,
    subject: env.OPENSHELL_SERVICE_ACCOUNT_SUBJECT,
  };
}
