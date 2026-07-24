import { useEffect, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import Markdown from 'react-markdown';
import type { CycleRun, TaskCycleGroup } from '../types';
import { fetchCycleRuns, fetchCycleRunsByTask, fetchCycleRunTranscript } from '../api';
import { useWS } from '../hooks/useWebSocket';
import CycleRunCard from '../components/CycleRunCard';
import { timeAgo, formatDuration, formatTokens, sourceUrl, displayKey } from '../utils';
import {
  Card,
  CardHeader,
  CardTitle,
  CardBody,
  Flex,
  FlexItem,
  Label,
  LabelGroup,
  Button,
  Content,
  Divider,
  DescriptionList,
  DescriptionListGroup,
  DescriptionListTerm,
  DescriptionListDescription,
  SearchInput,
  ToggleGroup,
  ToggleGroupItem
} from '@patternfly/react-core';
import { DownloadIcon, ExpandIcon, CompressIcon, TimesIcon } from '@patternfly/react-icons';

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
      <Button variant="secondary" onClick={load}>Load Transcript</Button>
    );
  }
  if (loading) return <Content component="p">Loading transcript...</Content>;
  if (error) return <Content component="p" style={{ color: 'var(--pf-t--global--color--status--danger--default)' }}>{error}</Content>;
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
      <Flex alignItems={{ default: 'alignItemsCenter' }} gap={{ default: 'gapSm' }} style={{ marginBottom: '8px' }}>
        <FlexItem>
          <Label variant="outline">{visible.length} entries</Label>
        </FlexItem>
        <FlexItem style={{ flex: 1 }}>
          <SearchInput
            placeholder="Search transcript..."
            value={search}
            onChange={(_e, val) => setSearch(val)}
            onClear={() => setSearch('')}
            onFocus={() => onRequestFullscreen?.()}
          />
        </FlexItem>
        <FlexItem>
          <Button variant="plain" size="sm" onClick={() => downloadText(transcript, `cycle-${runId}.jsonl`)} title="Download transcript">
            <DownloadIcon />
          </Button>
        </FlexItem>
        <FlexItem style={{ flexShrink: 0 }}>
          <ToggleGroup aria-label="View options">
            <ToggleGroupItem text="Thinking" isSelected={showThinking} onChange={() => setShowThinking(!showThinking)} />
            <ToggleGroupItem text="Raw" isSelected={rawMode} onChange={() => setRawMode(!rawMode)} />
          </ToggleGroup>
        </FlexItem>
      </Flex>
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
    <Card isGlass className={fullscreen ? 'detail-fullscreen' : ''}>
      <CardHeader
        actions={{ actions: (
          <Flex gap={{ default: 'gapSm' }}>
            <FlexItem>
              <Button variant="plain" onClick={onToggleFullscreen} title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}>
                {fullscreen ? <CompressIcon /> : <ExpandIcon />}
              </Button>
            </FlexItem>
            <FlexItem>
              <Button variant="plain" onClick={onClose}><TimesIcon /></Button>
            </FlexItem>
          </Flex>
        ) }}
      >
        <CardTitle>Cycle #{run.id}</CardTitle>
      </CardHeader>
      <CardBody>
        <DescriptionList isHorizontal isCompact>
          <DescriptionListGroup>
            <DescriptionListTerm>Type</DescriptionListTerm>
            <DescriptionListDescription>
              <Label color="blue">{run.cycle_type.replace(/_/g, ' ').toUpperCase()}</Label>
            </DescriptionListDescription>
          </DescriptionListGroup>
          {run.instance_id && (
            <DescriptionListGroup>
              <DescriptionListTerm>Instance</DescriptionListTerm>
              <DescriptionListDescription>{run.instance_id}</DescriptionListDescription>
            </DescriptionListGroup>
          )}
          <DescriptionListGroup>
            <DescriptionListTerm>Started</DescriptionListTerm>
            <DescriptionListDescription title={run.started_at}>{timeAgo(run.started_at)}</DescriptionListDescription>
          </DescriptionListGroup>
          {duration != null && (
            <DescriptionListGroup>
              <DescriptionListTerm>Duration</DescriptionListTerm>
              <DescriptionListDescription>{formatDuration(duration)}</DescriptionListDescription>
            </DescriptionListGroup>
          )}
          {run.tool_calls != null && (
            <DescriptionListGroup>
              <DescriptionListTerm>Tool Calls</DescriptionListTerm>
              <DescriptionListDescription>{run.tool_calls}</DescriptionListDescription>
            </DescriptionListGroup>
          )}
          {run.tokens_used != null && (
            <DescriptionListGroup>
              <DescriptionListTerm>Tokens</DescriptionListTerm>
              <DescriptionListDescription>{formatTokens(run.tokens_used)}</DescriptionListDescription>
            </DescriptionListGroup>
          )}
        </DescriptionList>

        {Object.keys(progress).length > 0 && (
          <>
            <Divider style={{ margin: '16px 0' }} />
            <Content component="h4">Progress</Content>
            <DescriptionList isCompact>
              {progress.last_step && (
                <DescriptionListGroup>
                  <DescriptionListTerm>Last step</DescriptionListTerm>
                  <DescriptionListDescription>{progress.last_step}</DescriptionListDescription>
                </DescriptionListGroup>
              )}
              {progress.next_step && (
                <DescriptionListGroup>
                  <DescriptionListTerm>Next step</DescriptionListTerm>
                  <DescriptionListDescription>{progress.next_step}</DescriptionListDescription>
                </DescriptionListGroup>
              )}
              {progress.external_key && (
                <DescriptionListGroup>
                  <DescriptionListTerm>Source</DescriptionListTerm>
                  <DescriptionListDescription>{progress.external_key}</DescriptionListDescription>
                </DescriptionListGroup>
              )}
              {progress.summary && (
                <DescriptionListGroup>
                  <DescriptionListTerm>Summary</DescriptionListTerm>
                  <DescriptionListDescription>{progress.summary}</DescriptionListDescription>
                </DescriptionListGroup>
              )}
              {progress.files_changed && (
                <DescriptionListGroup>
                  <DescriptionListTerm>Files</DescriptionListTerm>
                  <DescriptionListDescription>
                    {(progress.files_changed as string[]).map((f: string, i: number) => (
                      <div key={i}><code>{f}</code></div>
                    ))}
                  </DescriptionListDescription>
                </DescriptionListGroup>
              )}
              {progress.key_decisions && (
                <DescriptionListGroup>
                  <DescriptionListTerm>Decisions</DescriptionListTerm>
                  <DescriptionListDescription>{progress.key_decisions}</DescriptionListDescription>
                </DescriptionListGroup>
              )}
              {progress.blockers && (
                <DescriptionListGroup>
                  <DescriptionListTerm>Blockers</DescriptionListTerm>
                  <DescriptionListDescription>{progress.blockers}</DescriptionListDescription>
                </DescriptionListGroup>
              )}
            </DescriptionList>
          </>
        )}

        {run.input_prompt && (
          <>
            <Divider style={{ margin: '16px 0' }} />
            <Content component="h4">Input Prompt</Content>
            <pre className="input-prompt-content">{run.input_prompt}</pre>
          </>
        )}

        <Divider style={{ margin: '16px 0' }} />
        <Content component="h4">Transcript</Content>
        {run.has_transcript ? (
          <TranscriptViewer runId={run.id} onRequestFullscreen={() => { if (!fullscreen) onToggleFullscreen(); }} />
        ) : (
          <Content component="p" style={{ color: 'var(--pf-t--global--text--color--subtle, var(--text-dim))' }}>
            No transcript available for this cycle run.
          </Content>
        )}
      </CardBody>
    </Card>
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
    <Card isCompact isGlass isSelected={expanded} onClick={onClick} style={{ cursor: 'pointer', marginBottom: '8px' }}>
      <CardHeader
        actions={{ actions: (
          <Flex alignItems={{ default: 'alignItemsCenter' }} gap={{ default: 'gapSm' }}>
            {group.transcript_count > 0 && (
              <FlexItem>
                <Button
                  variant="plain"
                  size="sm"
                  onClick={handleDownload}
                  isDisabled={downloading}
                  title="Download all transcripts as ZIP"
                >
                  {downloading ? '...' : <DownloadIcon />}
                </Button>
              </FlexItem>
            )}
            <FlexItem>
              <Label variant="outline">{group.cycle_count} cycles</Label>
            </FlexItem>
          </Flex>
        ) }}
      >
        <CardTitle>
          <Flex alignItems={{ default: 'alignItemsCenter' }} gap={{ default: 'gapSm' }}>
            <FlexItem>
              {key ? (
                <a href={url || '#'} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
                  {key}
                </a>
              ) : (
                <span>{label}</span>
              )}
            </FlexItem>
            {group.task_status && (
              <FlexItem>
                <Label color="blue">{group.task_status}</Label>
              </FlexItem>
            )}
          </Flex>
        </CardTitle>
      </CardHeader>
      <CardBody>
        <Flex direction={{ default: 'column' }} gap={{ default: 'gapSm' }}>
          {group.title && (
            <FlexItem>
              <Content component="p" style={{ margin: 0 }}>{group.title}</Content>
            </FlexItem>
          )}
          <FlexItem>
            <LabelGroup>
              {group.repo && <Label variant="outline">{group.repo}</Label>}
              {group.total_tokens != null && <Label variant="outline">{formatTokens(group.total_tokens)} tokens</Label>}
              {group.transcript_count > 0 && <Label variant="outline">{group.transcript_count} transcripts</Label>}
              {group.last_cycle && <Label variant="outline">last {timeAgo(group.last_cycle)}</Label>}
            </LabelGroup>
          </FlexItem>
        </Flex>
      </CardBody>
    </Card>
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
