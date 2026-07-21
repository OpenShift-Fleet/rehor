import type { BotInstance } from './types';

export async function fetchStats() {
  return (await fetch('/api/stats')).json();
}

export async function fetchBotStatus() {
  return (await fetch('/api/bot-status')).json();
}

export async function fetchInstances(): Promise<BotInstance[]> {
  return (await fetch('/api/instances')).json();
}

export async function fetchTasks(params: { status?: string; exclude_status?: string; limit?: number; offset?: number; instance_id?: string }) {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  if (params.exclude_status) qs.set('exclude_status', params.exclude_status);
  if (params.instance_id) qs.set('instance_id', params.instance_id);
  qs.set('limit', String(params.limit ?? 20));
  qs.set('offset', String(params.offset ?? 0));
  return (await fetch('/api/tasks?' + qs)).json();
}

export async function deleteTask(key: string) {
  return fetch('/api/tasks/' + encodeURIComponent(key), { method: 'DELETE' });
}

export async function unarchiveTask(key: string) {
  return fetch('/api/tasks/' + encodeURIComponent(key) + '/unarchive', { method: 'POST' });
}

export async function pauseTask(key: string, pausedReason?: string) {
  return fetch('/api/tasks/' + encodeURIComponent(key) + '/pause', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paused_reason: pausedReason || undefined }),
  });
}

export async function unpauseTask(key: string) {
  return fetch('/api/tasks/' + encodeURIComponent(key) + '/unpause', { method: 'POST' });
}

export async function fetchMemories(params: { category?: string; repo?: string; tag?: string; limit?: number; offset?: number }) {
  const qs = new URLSearchParams();
  if (params.category) qs.set('category', params.category);
  if (params.repo) qs.set('repo', params.repo);
  if (params.tag) qs.set('tag', params.tag);
  qs.set('limit', String(params.limit ?? 20));
  qs.set('offset', String(params.offset ?? 0));
  return (await fetch('/api/memories?' + qs)).json();
}

export async function fetchMemory(id: number) {
  return (await fetch('/api/memories/' + id)).json();
}

export async function deleteMemory(id: number) {
  return fetch('/api/memories/' + id, { method: 'DELETE' });
}

export async function searchMemories(query: string, params?: { category?: string; repo?: string; tag?: string; limit?: number }) {
  const qs = new URLSearchParams({ q: query });
  if (params?.category) qs.set('category', params.category);
  if (params?.repo) qs.set('repo', params.repo);
  if (params?.tag) qs.set('tag', params.tag);
  if (params?.limit) qs.set('limit', String(params.limit));
  return (await fetch('/api/memories/search?' + qs)).json();
}

export async function fetchTags() {
  return (await fetch('/api/tags')).json();
}

export async function fetchEmbeddings() {
  return (await fetch('/api/memories/embeddings')).json();
}

export async function fetchCosts(days = 30, limit = 200, dateFrom?: string, dateTo?: string) {
  const qs = new URLSearchParams({ limit: String(limit) });
  if (dateFrom) qs.set('from', dateFrom);
  if (dateTo) qs.set('to', dateTo);
  if (!dateFrom && !dateTo) qs.set('days', String(days));
  return (await fetch(`/api/costs?${qs}`)).json();
}

export async function fetchCycleRuns(params: { task_id?: number | 'none'; instance_id?: string; cycle_type?: string; limit?: number; offset?: number }) {
  const qs = new URLSearchParams();
  if (params.task_id != null) qs.set('task_id', String(params.task_id));
  if (params.instance_id) qs.set('instance_id', params.instance_id);
  if (params.cycle_type) qs.set('cycle_type', params.cycle_type);
  qs.set('limit', String(params.limit ?? 50));
  qs.set('offset', String(params.offset ?? 0));
  return (await fetch('/api/cycle-runs?' + qs)).json();
}

export async function fetchCycleRunsByTask(params: { instance_id?: string }) {
  const qs = new URLSearchParams();
  if (params.instance_id) qs.set('instance_id', params.instance_id);
  return (await fetch('/api/cycle-runs/by-task?' + qs)).json();
}

export async function fetchCycleRunTranscript(id: number): Promise<string> {
  const res = await fetch(`/api/cycle-runs/${id}/transcript?decompress=true`);
  if (!res.ok) throw new Error(`Failed to fetch transcript: ${res.status}`);
  return res.text();
}

export async function wakeInstance(instanceId: string): Promise<{ ok: boolean }> {
  const res = await fetch(`/api/instances/${encodeURIComponent(instanceId)}/wake`, { method: 'POST' });
  return res.json();
}

export async function fetchAnalytics(days = 30, dateFrom?: string, dateTo?: string) {
  const qs = new URLSearchParams();
  if (dateFrom) qs.set('from', dateFrom);
  if (dateTo) qs.set('to', dateTo);
  if (!dateFrom && !dateTo) qs.set('days', String(days));
  return (await fetch(`/api/analytics?${qs}`)).json();
}
