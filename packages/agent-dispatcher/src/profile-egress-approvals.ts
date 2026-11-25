import type { SandboxEgressRequest } from "./profile-egress.js";

export type ProfileEgressContext = Readonly<{
  repository: string;
  profile: string;
  requests: readonly SandboxEgressRequest[];
}>;

export type ProfileEgressApproval = Readonly<{
  repository: string;
  profile: string;
  host: string;
  /** Stable public IPv4 addresses dedicated to the approved service. No CIDRs or wildcards. */
  allowedIps: readonly string[];
}>;

/** Platform-reviewed approvals only. Match the configured repository URL and
 * profile directory exactly. Add only public, non-credential-bearing services
 * after validating runtime enforcement in staging. No destinations ship approved. */
export const PROFILE_EGRESS_APPROVALS: readonly ProfileEgressApproval[] = [];
