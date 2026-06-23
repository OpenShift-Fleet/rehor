export interface SlackNotification {
  event_type: string;
  message: string;
  sent_at: string;
}

export interface Task {
  id: number;
  external_key: string;
  source_type: string;
  source_url: string | null;
  artifacts: Array<{ name: string; url: string; type: string }>;
  status: 'in_progress' | 'pr_open' | 'pr_changes' | 'paused' | 'done';
  repo: string;
  branch: string;
  title: string | null;
  summary: string | null;
  created_at: string;
  last_addressed: string;
  paused_reason: string | null;
  instance_id: string | null;
  metadata: Record<string, any>;
  slack_notification?: SlackNotification;
}

export interface Memory {
  id: number;
  category: string;
  repo: string;
  external_key: string | null;
  source_type: string | null;
  title: string;
  content: string;
  tags: string[];
  created_at: string;
  metadata: Record<string, any>;
  similarity?: number;
}

export interface BotInstance {
  instance_id: string;
  state: 'working' | 'idle' | 'error' | 'unknown';
  message: string;
  external_key: string | null;
  source_type: string | null;
  source_url: string | null;
  repo: string | null;
  cycle_start: string | null;
  updated_at: string;
  active_tasks: number;
  max_tasks: number;
}

export interface BotStatus {
  state: 'working' | 'idle' | 'error' | 'unknown';
  message: string;
  external_key: string | null;
  source_type: string | null;
  source_url: string | null;
  repo: string | null;
  instance_id: string | null;
  cycle_start: string | null;
  updated_at: string;
}

export interface CycleEntry {
  id: number;
  timestamp: string;
  label: string;
  session_id: string;
  num_turns: number;
  duration_ms: number;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  model: string;
  is_error: boolean;
  no_work: boolean;
  external_key: string | null;
  source_type: string | null;
  repo: string | null;
  work_type: string | null;
  summary: string | null;
}

export interface DailyAggregate {
  day: string;
  cycles: number;
  total_cost: number;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
  total_duration: number;
  total_turns: number;
  idle_cycles: number;
  error_cycles: number;
}

export interface EmbeddingPoint {
  id: number;
  title: string;
  content: string;
  category: string;
  repo: string;
  tags: string[];
  x: number;
  y: number;
  z: number;
}

export interface TaskCycleGroup {
  task_id: number | null;
  external_key: string | null;
  title: string | null;
  task_status: string | null;
  repo: string | null;
  cycle_count: number;
  transcript_count: number;
  total_tool_calls: number | null;
  total_tokens: number | null;
  first_cycle: string | null;
  last_cycle: string | null;
}

export interface CycleRun {
  id: number;
  task_id: number | null;
  cycle_type: string;
  instance_id: string | null;
  started_at: string;
  finished_at: string | null;
  tool_calls: number | null;
  tokens_used: number | null;
  progress: Record<string, any>;
  created_at: string;
  has_transcript?: boolean;
}

export interface WSEvent {
  type: string;
  data: any;
  timestamp: number;
}

export interface AnalyticsSummary {
  total_cycles: number;
  work_cycles: number;
  idle_cycles: number;
  error_cycles: number;
  unique_tickets: number;
  total_cost: number;
  avg_cost_per_work_cycle: number;
  avg_turns: number;
  avg_duration_ms: number;
  repos_touched: number;
  tickets_resolved: number;
}

export interface WorkTypeEntry {
  category: string;
  cycles: number;
  total_cost: number;
  avg_cost: number;
  avg_turns: number;
  avg_duration_ms: number;
}

export interface RepoEntry {
  repo: string;
  tickets: number;
  cycles: number;
  total_cost: number;
  avg_turns: number;
}

export interface TicketEntry {
  external_key: string;
  title: string | null;
  status: string | null;
  repo: string | null;
  total_cycles: number;
  impl_cycles: number;
  review_cycles: number;
  total_cost: number;
  hours_span: number;
}

export interface FeedbackStats {
  avg_review_rounds: number;
  zero_review: number;
  one_review: number;
  multi_review: number;
}

export interface AnalyticsData {
  summary: AnalyticsSummary;
  work_types: WorkTypeEntry[];
  repos: RepoEntry[];
  tickets: TicketEntry[];
  feedback: FeedbackStats;
}
