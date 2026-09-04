import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fetchStats,
  fetchBotStatus,
  fetchInstances,
  fetchTasks,
  deleteTask,
  unarchiveTask,
  pauseTask,
  unpauseTask,
  fetchMemories,
  fetchMemory,
  deleteMemory,
  searchMemories,
  fetchTags,
  fetchEmbeddings,
  fetchCosts,
  fetchCycleRuns,
  fetchCycleRunsByTask,
  fetchCycleRunTranscript,
  fetchAnalytics,
} from './api';

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

function jsonResponse(data: unknown) {
  return { json: () => Promise.resolve(data), ok: true, text: () => Promise.resolve('') };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockResolvedValue(jsonResponse({}));
});

describe('fetchStats', () => {
  it('calls /api/stats', async () => {
    const data = { tasks: 5 };
    mockFetch.mockResolvedValue(jsonResponse(data));
    const result = await fetchStats();
    expect(mockFetch).toHaveBeenCalledWith('/api/stats');
    expect(result).toEqual(data);
  });
});

describe('fetchBotStatus', () => {
  it('calls /api/bot-status', async () => {
    const data = { state: 'idle' };
    mockFetch.mockResolvedValue(jsonResponse(data));
    const result = await fetchBotStatus();
    expect(mockFetch).toHaveBeenCalledWith('/api/bot-status');
    expect(result).toEqual(data);
  });
});

describe('fetchInstances', () => {
  it('calls /api/instances', async () => {
    const data = [{ instance_id: 'bot-1' }];
    mockFetch.mockResolvedValue(jsonResponse(data));
    const result = await fetchInstances();
    expect(mockFetch).toHaveBeenCalledWith('/api/instances');
    expect(result).toEqual(data);
  });
});

describe('fetchTasks', () => {
  it('builds query with all params', async () => {
    await fetchTasks({
      status: 'in_progress',
      exclude_status: 'archived',
      instance_id: 'dev-bot',
      limit: 50,
      offset: 10,
    });
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/tasks?status=in_progress&exclude_status=archived&instance_id=dev-bot&limit=50&offset=10',
    );
  });

  it('uses default limit and offset', async () => {
    await fetchTasks({});
    expect(mockFetch).toHaveBeenCalledWith('/api/tasks?limit=20&offset=0');
  });

  it('includes only provided params', async () => {
    await fetchTasks({ status: 'paused' });
    expect(mockFetch).toHaveBeenCalledWith('/api/tasks?status=paused&limit=20&offset=0');
  });
});

describe('deleteTask', () => {
  it('sends DELETE with encoded key', async () => {
    mockFetch.mockResolvedValue({ ok: true });
    await deleteTask('RHCLOUD/001');
    expect(mockFetch).toHaveBeenCalledWith('/api/tasks/RHCLOUD%2F001', { method: 'DELETE' });
  });
});

describe('unarchiveTask', () => {
  it('sends POST to unarchive endpoint', async () => {
    mockFetch.mockResolvedValue({ ok: true });
    await unarchiveTask('RHCLOUD-100');
    expect(mockFetch).toHaveBeenCalledWith('/api/tasks/RHCLOUD-100/unarchive', { method: 'POST' });
  });
});

describe('pauseTask', () => {
  it('sends POST with paused_reason body', async () => {
    mockFetch.mockResolvedValue({ ok: true });
    await pauseTask('RHCLOUD-200', 'blocked');
    expect(mockFetch).toHaveBeenCalledWith('/api/tasks/RHCLOUD-200/pause', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paused_reason: 'blocked' }),
    });
  });

  it('omits paused_reason when not provided', async () => {
    mockFetch.mockResolvedValue({ ok: true });
    await pauseTask('RHCLOUD-200');
    expect(mockFetch).toHaveBeenCalledWith('/api/tasks/RHCLOUD-200/pause', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paused_reason: undefined }),
    });
  });
});

describe('unpauseTask', () => {
  it('sends POST to unpause endpoint', async () => {
    mockFetch.mockResolvedValue({ ok: true });
    await unpauseTask('RHCLOUD-300');
    expect(mockFetch).toHaveBeenCalledWith('/api/tasks/RHCLOUD-300/unpause', { method: 'POST' });
  });
});

describe('fetchMemories', () => {
  it('builds query with filters and defaults', async () => {
    await fetchMemories({ category: 'pattern', repo: 'org/repo', tag: 'auth', limit: 10, offset: 5 });
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/memories?category=pattern&repo=org%2Frepo&tag=auth&limit=10&offset=5',
    );
  });

  it('uses default limit and offset', async () => {
    await fetchMemories({});
    expect(mockFetch).toHaveBeenCalledWith('/api/memories?limit=20&offset=0');
  });
});

describe('fetchMemory', () => {
  it('calls memory by id', async () => {
    await fetchMemory(42);
    expect(mockFetch).toHaveBeenCalledWith('/api/memories/42');
  });
});

describe('deleteMemory', () => {
  it('sends DELETE', async () => {
    mockFetch.mockResolvedValue({ ok: true });
    await deleteMemory(7);
    expect(mockFetch).toHaveBeenCalledWith('/api/memories/7', { method: 'DELETE' });
  });
});

describe('searchMemories', () => {
  it('builds search query with required q param', async () => {
    await searchMemories('login bug');
    expect(mockFetch).toHaveBeenCalledWith('/api/memories/search?q=login+bug');
  });

  it('includes optional params', async () => {
    await searchMemories('auth', { category: 'pattern', repo: 'org/repo', tag: 'security', limit: 5 });
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/memories/search?q=auth&category=pattern&repo=org%2Frepo&tag=security&limit=5',
    );
  });
});

describe('fetchTags', () => {
  it('calls /api/tags', async () => {
    await fetchTags();
    expect(mockFetch).toHaveBeenCalledWith('/api/tags');
  });
});

describe('fetchEmbeddings', () => {
  it('calls /api/memories/embeddings', async () => {
    await fetchEmbeddings();
    expect(mockFetch).toHaveBeenCalledWith('/api/memories/embeddings');
  });
});

describe('fetchCosts', () => {
  it('uses days param when no date range', async () => {
    await fetchCosts(14, 100);
    expect(mockFetch).toHaveBeenCalledWith('/api/costs?limit=100&days=14');
  });

  it('uses from/to when date range provided', async () => {
    await fetchCosts(30, 200, '2025-01-01', '2025-01-31');
    expect(mockFetch).toHaveBeenCalledWith('/api/costs?limit=200&from=2025-01-01&to=2025-01-31');
  });

  it('uses default days and limit', async () => {
    await fetchCosts();
    expect(mockFetch).toHaveBeenCalledWith('/api/costs?limit=200&days=30');
  });
});

describe('fetchCycleRuns', () => {
  it('builds query with all params', async () => {
    await fetchCycleRuns({ task_id: 42, instance_id: 'dev-bot', cycle_type: 'task_work', limit: 10, offset: 5 });
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/cycle-runs?task_id=42&instance_id=dev-bot&cycle_type=task_work&limit=10&offset=5',
    );
  });

  it('supports task_id none', async () => {
    await fetchCycleRuns({ task_id: 'none' });
    expect(mockFetch).toHaveBeenCalledWith('/api/cycle-runs?task_id=none&limit=50&offset=0');
  });

  it('uses defaults', async () => {
    await fetchCycleRuns({});
    expect(mockFetch).toHaveBeenCalledWith('/api/cycle-runs?limit=50&offset=0');
  });
});

describe('fetchCycleRunsByTask', () => {
  it('includes instance_id when provided', async () => {
    await fetchCycleRunsByTask({ instance_id: 'dev-bot' });
    expect(mockFetch).toHaveBeenCalledWith('/api/cycle-runs/by-task?instance_id=dev-bot');
  });

  it('calls without params', async () => {
    await fetchCycleRunsByTask({});
    expect(mockFetch).toHaveBeenCalledWith('/api/cycle-runs/by-task?');
  });
});

describe('fetchCycleRunTranscript', () => {
  it('returns text on success', async () => {
    mockFetch.mockResolvedValue({ ok: true, text: () => Promise.resolve('line1\nline2') });
    const result = await fetchCycleRunTranscript(99);
    expect(mockFetch).toHaveBeenCalledWith('/api/cycle-runs/99/transcript?decompress=true');
    expect(result).toBe('line1\nline2');
  });

  it('throws on failure', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404 });
    await expect(fetchCycleRunTranscript(99)).rejects.toThrow('Failed to fetch transcript: 404');
  });
});

describe('fetchAnalytics', () => {
  it('uses days param when no date range', async () => {
    await fetchAnalytics(7);
    expect(mockFetch).toHaveBeenCalledWith('/api/analytics?days=7');
  });

  it('uses from/to when date range provided', async () => {
    await fetchAnalytics(30, '2025-06-01', '2025-06-30');
    expect(mockFetch).toHaveBeenCalledWith('/api/analytics?from=2025-06-01&to=2025-06-30');
  });

  it('uses default days', async () => {
    await fetchAnalytics();
    expect(mockFetch).toHaveBeenCalledWith('/api/analytics?days=30');
  });
});
