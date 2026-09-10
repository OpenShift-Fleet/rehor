export const REHOR_SCHEMA_VERSION = "1" as const;

export type RehorSchemaVersion = typeof REHOR_SCHEMA_VERSION;

export interface ContentHash {
  algorithm: "sha256";
  value: string;
}

export interface RepositorySnapshot {
  ref: string;
  commitSha: string;
  dirty: boolean;
}

export interface Worktree {
  path: string;
  repository: string;
  snapshot: RepositorySnapshot;
}

export interface TaskIdentity {
  id: string;
  key?: string;
}

export interface ProviderSelection {
  id: string;
  requestedModel: string;
  reasoningEffort?: string;
}

export interface RunLimits {
  timeoutMs: number;
  maxTurns: number;
  maxOutputTokens?: number;
}

/** Runtime-neutral input for one independently attributable model attempt. */
export interface RehorRun {
  schemaVersion: RehorSchemaVersion;
  runId: string;
  attemptId: string;
  instanceId: string;
  /** Existing runner label used for status, metrics, and prompt context. */
  label: string;
  workflowId: string;
  /** Fully assembled runtime-neutral prompt, including any preflight content. */
  prompt: string;
  /** Null while a triage cycle has not selected or created a task. */
  task: TaskIdentity | null;
  worktree: Worktree;
  instructionHash: ContentHash;
  configHash: ContentHash;
  policyHash: ContentHash;
  provider: ProviderSelection;
  limits: RunLimits;
  preflightPayloadRef: string | null;
}
