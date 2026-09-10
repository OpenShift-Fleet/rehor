export type UsageGuarantee = "none" | "partial" | "final" | "partial-and-final";

export interface RuntimeCapabilities {
  runtimeId: string;
  runtimeVersion: string;
  configVersion: string;
  streaming: boolean;
  interruption: boolean;
  childSessions: boolean;
  toolSupport: boolean;
  mcpSupport: boolean;
  structuredOutput: boolean;
  usageGuarantee: UsageGuarantee;
}
