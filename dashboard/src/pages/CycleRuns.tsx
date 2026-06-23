import { useEffect, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import Markdown from 'react-markdown';
import type { CycleRun, TaskCycleGroup } from '../types';
import { fetchCycleRuns, fetchCycleRunsByTask, fetchCycleRunTranscript } from '../api';
import { useWS } from '../hooks/useWebSocket';
import CycleRunCard from '../components/CycleRunCard';
import { timeAgo, formatDuration, formatTokens, sourceUrl, displayKey } from '../utils';

import JSZip from 'jszip';

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadText(content: string, filename: string) {
  downloadBlob(new Blob([content], { type: 'application/x-ndjson' }), filename);
}

async function downloadAllTranscripts(taskId: number | null, key: string | null, instanceId?: string) {
  const params: { task_id?: number | 'none'; instance_id?: string; limit: number } = { limit: 100 };
  if (taskId != null) params.task_id = taskId;
  else if (!key) params.task_id = 'none';
  if (instanceId) params.instance_id = instanceId;
  const res = await fetchCycleRuns(params);
  const runs: CycleRun[] = res.items || [];

  const zip = new JSZip();
  for (const run of runs) {
    try {
      const text = await fetchCycleRunTranscript(run.id);
      const ts = run.started_at.replace(/[:.]/g, '-').slice(0, 19);
      zip.file(`cycle-${run.id}-${run.cycle_type}-${ts}.jsonl`, text);
    } catch {
      // skip cycles without transcript
    }
  }

  const label = key || (taskId != null ? `task-${taskId}` : 'orphan');
  const blob = await zip.generateAsync({ type: 'blob' });
  downloadBlob(blob, `transcripts-${label}.zip`);
}

interface ParsedEntry {
  role: string;
  blockType: string;
  label: string;
  content: string;
  isLarge: boolean;
}

function parseTranscript(raw: string): ParsedEntry[] {
  const entries: ParsedEntry[] = [];
  for (const line of raw.trim().split('\n')) {
    let data: any;
    try {
      data = JSON.parse(line);
    } catch {
      continue;
    }
    const lineType = data.type || '';
    if (!data.message || lineType === 'queue-operation' || lineType === 'last-prompt' || lineType === 'attachment') {
      continue;
    }
    const msg = data.message;
    const role = msg.role || lineType;
    const blocks = Array.isArray(msg.content) ? msg.content : [];

    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      const bt = block.type || '';

      if (bt === 'text') {
        const text = block.text || '';
        if (text.trim()) {
          entries.push({ role, blockType: 'text', label: '', content: text, isLarge: text.length > 500 });
        }
      } else if (bt === 'thinking') {
        const text = block.thinking || '';
        if (text.trim()) {
          entries.push({ role: 'thinking', blockType: 'thinking', label: '', content: text, isLarge: text.length > 300 });
        }
      } else if (bt === 'tool_use') {
        const name = block.name || '?';
        const input = block.input || {};
        const summary = Object.entries(input).slice(0, 3).map(([k, v]) => `${k}=${String(v).slice(0, 60)}`).join(', ');
        entries.push({ role: 'tool', blockType: 'tool_use', label: name, content: summary, isLarge: false });
      } else if (bt === 'tool_result') {
        let content = block.content || '';
        if (Array.isArray(content)) {
          content = content.map((c: any) => typeof c === 'string' ? c : c.text || JSON.stringify(c)).join('\n');
        }
        const text = typeof content === 'string' ? content : JSON.stringify(content);
        entries.push({ role: 'result', blockType: 'tool_result', label: '', content: text, isLarge: text.length > 300 });
      }
    }
  }
  return entries;
}

const transcriptCache = new Map<number, string>();

function Highlight({ text, search }: { text: string; search: string }) {
  if (!search) return <>{text}</>;
  const parts = text.split(new RegExp(`(${search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'));
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === search.toLowerCase() ? (
          <mark key={i} className="search-highlight">{part}</mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}

function TranscriptViewer({ runId, onRequestFullscreen }: { runId: number; onRequestFullscreen?: () => void }) {
  const [transcript, setTranscript] = useState<string | null>(
    transcriptCache.get(runId) ?? null
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rawMode, setRawMode] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<number>>(() => {
    const cached = transcriptCache.get(runId);
    if (cached) {
      const largeIds = new Set<number>();
      parseTranscript(cached).forEach((e, i) => { if (e.isLarge) largeIds.add(i); });
      return largeIds;
    }
    return new Set();
  });
  const [showThinking, setShowThinking] = useState(false);
  const [search, setSearch] = useState('');

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const text = await fetchCycleRunTranscript(runId);
      transcriptCache.set(runId, text);
      setTranscript(text);
      const parsed = parseTranscript(text);
      const largeIds = new Set<number>();
      parsed.forEach((e, i) => { if (e.isLarge) largeIds.add(i); });
      setCollapsed(largeIds);
    } catch (e: any) {
      setError(e.message || 'Failed to load transcript');
    } finally {
      setLoading(false);
    }
  };

  if (transcript === null && !loading && !error) {
    return (
      <div className="transcript-load">
        <button className="btn-load-transcript" onClick={load}>Load Transcript</button>
      </div>
    );
  }
  if (loading) return <div className="transcript-loading">Loading transcript...</div>;
  if (error) return <div className="transcript-error">{error}</div>;
  if (!transcript) return null;

  const entries = parseTranscript(transcript);
  const searchLower = search.toLowerCase();
  let visible = showThinking ? entries : entries.filter((e) => e.blockType !== 'thinking');
  if (search) {
    visible = visible.filter(
      (e) => e.content.toLowerCase().includes(searchLower) || e.label.toLowerCase().includes(searchLower)
    );
  }

  const toggleCollapse = (idx: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  return (
    <div className="transcript-viewer">
      <div className="transcript-controls">
        <span className="transcript-count">{visible.length} entries</span>
        <input
          className="transcript-search"
          type="text"
          placeholder="Search transcript..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onFocus={() => onRequestFullscreen?.()}
        />
        <div className="transcript-buttons">
          <button
            className="btn-download-cycle"
            onClick={() => downloadText(transcript, `cycle-${runId}.jsonl`)}
            title="Download transcript"
          >
            &#11015;
          </button>
          <button
            className={`btn-toggle-raw ${showThinking ? 'active' : ''}`}
            onClick={() => setShowThinking(!showThinking)}
          >
            Thinking
          </button>
          <button
            className={`btn-toggle-raw ${rawMode ? 'active' : ''}`}
            onClick={() => setRawMode(!rawMode)}
          >
            Raw
          </button>
        </div>
      </div>
      {rawMode ? (
        <pre className="transcript-raw">{transcript}</pre>
      ) : (
        <div className="transcript-messages">
          {visible.map((entry, i) => {
            const isCollapsed = collapsed.has(i) && !search;
            return (
              <div key={i} className={`transcript-line role-${entry.role}`}>
                <div className="transcript-line-header" onClick={() => entry.isLarge && toggleCollapse(i)}>
                  <span className="transcript-role">{entry.role}</span>
                  {entry.label && (
                    <span className="transcript-tool-name">
                      <Highlight text={entry.label} search={search} />
                    </span>
                  )}
                  {entry.isLarge && !search && (
                    <span className="transcript-toggle">{collapsed.has(i) ? '[+]' : '[-]'}</span>
                  )}
                </div>
                {!isCollapsed && (
                  entry.blockType === 'text' || entry.blockType === 'thinking' ? (
                    <div className="transcript-line-md">
                      {search ? (
                        <pre className="transcript-line-content">
                          <Highlight text={entry.content.slice(0, 5000)} search={search} />
                        </pre>
                      ) : (
                        <Markdown>{entry.content.slice(0, 5000)}</Markdown>
                      )}
                    </div>
                  ) : (
                    <pre className="transcript-line-content">
                      <Highlight text={entry.content.slice(0, 3000)} search={search} />
                    </pre>
                  )
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CycleRunDetail({
  run,
  onClose,
  fullscreen,
  onToggleFullscreen,
}: {
  run: CycleRun;
  onClose: () => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
}) {
  const progress = run.progress || {};
  const duration =
    run.started_at && run.finished_at
      ? new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()
      : null;

  return (
    <div className={`detail-panel${fullscreen ? ' detail-fullscreen' : ''}`}>
      <div className="detail-header">
        <h3>Cycle #{run.id}</h3>
        <div className="detail-header-actions">
          <button className="detail-expand" onClick={onToggleFullscreen} title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}>
            {fullscreen ? '⊟' : '⊞'}
          </button>
          <button className="detail-close" onClick={onClose}>X</button>
        </div>
      </div>
      <div className="detail-body">
        <div className="detail-meta-grid">
          <div className="detail-meta-item">
            <span className="detail-label">Type</span>
            <span className={`cycle-type-badge ${run.cycle_type}`}>
              {run.cycle_type.replace(/_/g, ' ')}
            </span>
          </div>
          {run.instance_id && (
            <div className="detail-meta-item">
              <span className="detail-label">Instance</span>
              <span>{run.instance_id}</span>
            </div>
          )}
          <div className="detail-meta-item">
            <span className="detail-label">Started</span>
            <span title={run.started_at}>{timeAgo(run.started_at)}</span>
          </div>
          {duration != null && (
            <div className="detail-meta-item">
              <span className="detail-label">Duration</span>
              <span>{formatDuration(duration)}</span>
            </div>
          )}
          {run.tool_calls != null && (
            <div className="detail-meta-item">
              <span className="detail-label">Tool Calls</span>
              <span>{run.tool_calls}</span>
            </div>
          )}
          {run.tokens_used != null && (
            <div className="detail-meta-item">
              <span className="detail-label">Tokens</span>
              <span>{formatTokens(run.tokens_used)}</span>
            </div>
          )}
        </div>

        {Object.keys(progress).length > 0 && (
          <div className="detail-section">
            <span className="detail-label">Progress</span>
            <div className="progress-info">
              {progress.last_step && <div><strong>Last step:</strong> {progress.last_step}</div>}
              {progress.next_step && <div><strong>Next step:</strong> {progress.next_step}</div>}
              {progress.external_key && <div><strong>Source:</strong> {progress.external_key}</div>}
              {progress.summary && <div><strong>Summary:</strong> {progress.summary}</div>}
              {progress.files_changed && (
                <div>
                  <strong>Files:</strong>
                  <ul>
                    {(progress.files_changed as string[]).map((f: string, i: number) => (
                      <li key={i}><code>{f}</code></li>
                    ))}
                  </ul>
                </div>
              )}
              {progress.key_decisions && <div><strong>Decisions:</strong> {progress.key_decisions}</div>}
              {progress.blockers && <div><strong>Blockers:</strong> {progress.blockers}</div>}
            </div>
          </div>
        )}

        {run.has_transcript ? (
          <div className="detail-section">
            <span className="detail-label">Transcript</span>
            <TranscriptViewer runId={run.id} onRequestFullscreen={() => { if (!fullscreen) onToggleFullscreen(); }} />
          </div>
        ) : (
          <div className="detail-section">
            <span className="detail-label">Transcript</span>
            <span className="transcript-unavailable">No transcript available for this cycle run.</span>
          </div>
        )}
      </div>
    </div>
  );
}

function TaskGroupCard({
  group,
  expanded,
  onClick,
  instanceId,
}: {
  group: TaskCycleGroup;
  expanded: boolean;
  onClick: () => void;
  instanceId?: string;
}) {
  const key = displayKey(group);
  const url = sourceUrl(group);
  const label = key || (group.task_id != null ? `Task #${group.task_id}` : 'Orphan cycles');
  const [downloading, setDownloading] = useState(false);

  const handleDownload = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setDownloading(true);
    try {
      await downloadAllTranscripts(group.task_id, key || null, instanceId);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className={`task-group-card${expanded ? ' expanded' : ''}`} onClick={onClick}>
      <div className="task-group-header">
        <div className="task-group-title">
          {key ? (
            <a
              href={url || '#'}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
            >
              {key}
            </a>
          ) : (
            <span>{label}</span>
          )}
          {group.task_status && (
            <span className={`status-badge ${group.task_status}`}>{group.task_status}</span>
          )}
        </div>
        <div className="task-group-actions">
          {group.transcript_count > 0 && (
            <button
              className="btn-download-zip"
              onClick={handleDownload}
              disabled={downloading}
              title="Download all transcripts as ZIP"
            >
              {downloading ? '...' : 'ZIP'}
            </button>
          )}
          <span className="task-group-count">{group.cycle_count} cycles</span>
        </div>
      </div>
      {group.title && <div className="task-group-subtitle">{group.title}</div>}
      <div className="task-group-meta">
        {group.repo && <span>{group.repo}</span>}
        {group.total_tokens != null && <span>{formatTokens(group.total_tokens)} tokens</span>}
        {group.transcript_count > 0 && <span>{group.transcript_count} transcripts</span>}
        {group.last_cycle && <span title={group.last_cycle}>last {timeAgo(group.last_cycle)}</span>}
      </div>
    </div>
  );
}

function groupKey(g: TaskCycleGroup): string {
  if (g.task_id != null) return `t:${g.task_id}`;
  const key = g.external_key;
  if (key) return `k:${key}`;
  return 'orphan';
}

export default function CycleRuns({ instanceId }: { instanceId?: string }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [groups, setGroups] = useState<TaskCycleGroup[]>([]);
  const [expandedGroupKey, setExpandedGroupKey] = useState<string | undefined>(undefined);
  const [runs, setRuns] = useState<CycleRun[]>([]);
  const [selectedRun, setSelectedRun] = useState<CycleRun | null>(null);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullscreen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  const { onEvent } = useWS();

  const loadGroups = useCallback(async () => {
    const data = await fetchCycleRunsByTask({ instance_id: instanceId });
    setGroups(data || []);
  }, [instanceId]);

  const loadCyclesForTask = useCallback(async (taskId: number | null, orphan = false) => {
    setLoadingRuns(true);
    try {
      const params: { task_id?: number | 'none'; instance_id?: string; limit: number } = { limit: 50 };
      if (taskId != null) params.task_id = taskId;
      else if (orphan) params.task_id = 'none';
      if (instanceId) params.instance_id = instanceId;
      const res = await fetchCycleRuns(params);
      setRuns(res.items || []);
      return res.items || [];
    } finally {
      setLoadingRuns(false);
    }
  }, [instanceId]);

  useEffect(() => {
    loadGroups();
  }, [loadGroups]);

  useEffect(() => {
    const cycleParam = searchParams.get('cycle');
    const taskParam = searchParams.get('task_id');
    if (cycleParam && groups.length > 0) {
      const cycleId = parseInt(cycleParam);
      const tid = taskParam ? parseInt(taskParam) : null;
      const match = groups.find((g) => g.task_id === tid);
      setExpandedGroupKey(match ? groupKey(match) : tid != null ? `t:${tid}` : 'orphan');
      loadCyclesForTask(tid, tid == null).then((items) => {
        const found = items.find((r: CycleRun) => r.id === cycleId);
        if (found) setSelectedRun(found);
      });
    }
  }, [searchParams, groups, loadCyclesForTask]);

  useEffect(() => {
    return onEvent((event) => {
      if (event.type === 'cycle_run_added') {
        loadGroups();
      }
    });
  }, [onEvent, loadGroups]);

  const handleGroupClick = async (g: TaskCycleGroup) => {
    const key = groupKey(g);
    if (expandedGroupKey === key) {
      setExpandedGroupKey(undefined);
      setRuns([]);
      setSelectedRun(null);
      setFullscreen(false);
      return;
    }
    setExpandedGroupKey(key);
    setSelectedRun(null);
    setFullscreen(false);
    const isOrphan = g.task_id == null && !g.external_key;
    await loadCyclesForTask(g.task_id, isOrphan);
  };

  const handleSelectRun = (run: CycleRun) => {
    setSelectedRun(run);
    setFullscreen(false);
    const params = new URLSearchParams(searchParams);
    params.set('cycle', String(run.id));
    if (run.task_id != null) params.set('task_id', String(run.task_id));
    else params.delete('task_id');
    setSearchParams(params, { replace: true });
  };

  const handleClose = () => {
    setSelectedRun(null);
    setFullscreen(false);
    const params = new URLSearchParams(searchParams);
    params.delete('cycle');
    params.delete('task_id');
    setSearchParams(params, { replace: true });
  };

  if (fullscreen && selectedRun) {
    return (
      <CycleRunDetail
        run={selectedRun}
        onClose={handleClose}
        fullscreen={true}
        onToggleFullscreen={() => setFullscreen(false)}
      />
    );
  }

  return (
    <div className="split-layout">
      <div className="split-main">
        <div className="task-group-list">
          {groups.length === 0 && <div className="empty-state">No cycle runs found</div>}
          {groups.map((g) => {
            const gk = groupKey(g);
            const isExpanded = expandedGroupKey === gk;
            return (
              <div key={gk}>
                <TaskGroupCard
                  group={g}
                  expanded={isExpanded}
                  onClick={() => handleGroupClick(g)}
                  instanceId={instanceId}
                />
                {isExpanded && (
                  <div className="task-group-cycles">
                    {loadingRuns ? (
                      <div className="empty-state">Loading cycles...</div>
                    ) : (
                      runs.map((r) => (
                        <CycleRunCard
                          key={r.id}
                          run={r}
                          selected={selectedRun?.id === r.id}
                          onClick={() => handleSelectRun(r)}
                        />
                      ))
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {selectedRun && (
        <div className="split-detail">
          <CycleRunDetail
            run={selectedRun}
            onClose={handleClose}
            fullscreen={false}
            onToggleFullscreen={() => setFullscreen(true)}
          />
        </div>
      )}
    </div>
  );
}
