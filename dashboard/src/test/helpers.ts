import type {
  Task,
  CycleRun,
  TaskCycleGroup,
  BotInstance,
  BotStatus,
  CycleEntry,
  DailyAggregate,
  AnalyticsData,
} from '../types';
import fixtures from './fixtures.json';

const defaultTask: Task = fixtures.tasks['RHCLOUD-001'] as Task;
const defaultCycleRun: CycleRun = fixtures.cycleRuns[0] as CycleRun;
const defaultCycleEntry: CycleEntry = fixtures.costs[0] as CycleEntry;
const defaultBotStatus: BotStatus = fixtures.botStatus as BotStatus;
const defaultTaskCycleGroup: TaskCycleGroup = fixtures.taskCycleGroups[0] as TaskCycleGroup;

export function makeTask(overrides: Partial<Task> = {}): Task {
  return { ...defaultTask, ...overrides };
}

export function makeCycleRun(overrides: Partial<CycleRun> = {}): CycleRun {
  return { ...defaultCycleRun, ...overrides };
}

export function makeTaskCycleGroup(overrides: Partial<TaskCycleGroup> = {}): TaskCycleGroup {
  return { ...defaultTaskCycleGroup, ...overrides };
}

export function makeBotInstance(overrides: Partial<BotInstance> = {}): BotInstance {
  return {
    instance_id: defaultBotStatus.instance_id ?? 'dev-bot',
    state: 'idle',
    message: defaultBotStatus.message,
    external_key: defaultBotStatus.external_key,
    source_type: defaultBotStatus.source_type,
    source_url: defaultBotStatus.source_url,
    repo: defaultBotStatus.repo,
    cycle_start: defaultBotStatus.cycle_start,
    updated_at: defaultBotStatus.updated_at,
    last_seen: null,
    active_tasks: 2,
    max_tasks: 10,
    ...overrides,
  };
}

export function makeBotStatus(overrides: Partial<BotStatus> = {}): BotStatus {
  return { ...defaultBotStatus, ...overrides };
}

export function makeCycleEntry(overrides: Partial<CycleEntry> = {}): CycleEntry {
  return { ...defaultCycleEntry, ...overrides };
}

export function makeDailyAggregate(overrides: Partial<DailyAggregate> = {}): DailyAggregate {
  return {
    day: '2025-07-01',
    cycles: 10,
    total_cost: 5.5,
    input_tokens: 10000,
    output_tokens: 5000,
    cache_read: 2000,
    cache_write: 1000,
    total_duration: 3600000,
    total_turns: 50,
    idle_cycles: 2,
    error_cycles: 0,
    ...overrides,
  };
}

export function makeAnalyticsData(overrides: Partial<AnalyticsData> = {}): AnalyticsData {
  return { ...(fixtures.analytics as AnalyticsData), ...overrides };
}
