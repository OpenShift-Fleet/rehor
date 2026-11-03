import { parseHttpsUrl } from "./url.js";

export type GatewayConfig = {
  endpoint: string;
  name: string;
  issuer: string;
  clientId: string;
  audience: string;
  clientSecret: string;
  subject?: string;
};

// Gateway preflight is opt-in: with no OPENSHELL_* variables set the dispatcher
// runs without it. Once any variable is present, all six required ones must be
// set and well-formed; the subject is optional but must be well-formed if set.
const requiredKeys = [
  "OPENSHELL_GATEWAY_ENDPOINT",
  "OPENSHELL_GATEWAY_NAME",
  "OPENSHELL_OIDC_ISSUER",
  "OPENSHELL_CLIENT_ID",
  "OPENSHELL_OIDC_AUDIENCE",
  "OPENSHELL_OIDC_CLIENT_SECRET",
] as const;
const optionalKeys = ["OPENSHELL_SERVICE_ACCOUNT_SUBJECT"] as const;
const allKeys = [...requiredKeys, ...optionalKeys];

// A configuration value is well-formed when it is non-empty and carries no
// surrounding whitespace that a trim would silently remove. Errors name the
// variable and the problem, never the value, so a bad configuration is
// diagnosable from logs without leaking secrets.
function requireWellFormed(key: string, value: string | undefined): void {
  if (value === undefined) throw new Error(`${key} is required when gateway configuration is present`);
  if (value === "") throw new Error(`${key} must not be empty`);
  if (value.trim() !== value) throw new Error(`${key} must not have surrounding whitespace`);
}

// The gateway endpoint must be a bare origin; the OIDC issuer may carry a
// realm path. Everything else is covered by the shared HTTPS URL checks.
function httpsUrl(value: string, label: string, originOnly = false): string {
  const url = parseHttpsUrl(value, label);
  if (originOnly && url.pathname !== "/") throw new Error(`${label} must be an origin without a path`);
  return url.toString().replace(/\/$/, "");
}

export function readGatewayConfig(env: NodeJS.ProcessEnv): GatewayConfig | undefined {
  if (!allKeys.some((key) => env[key] !== undefined)) return undefined;
  for (const key of requiredKeys) requireWellFormed(key, env[key]);
  const subject = env.OPENSHELL_SERVICE_ACCOUNT_SUBJECT;
  if (subject !== undefined) requireWellFormed("OPENSHELL_SERVICE_ACCOUNT_SUBJECT", subject);
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new Error("NODE_TLS_REJECT_UNAUTHORIZED must not be 0: it would disable TLS certificate verification");
  }
  return {
    endpoint: httpsUrl(env.OPENSHELL_GATEWAY_ENDPOINT!, "OPENSHELL_GATEWAY_ENDPOINT", true),
    name: env.OPENSHELL_GATEWAY_NAME!,
    issuer: httpsUrl(env.OPENSHELL_OIDC_ISSUER!, "OPENSHELL_OIDC_ISSUER"),
    clientId: env.OPENSHELL_CLIENT_ID!,
    audience: env.OPENSHELL_OIDC_AUDIENCE!,
    clientSecret: env.OPENSHELL_OIDC_CLIENT_SECRET!,
    subject,
  };
}
