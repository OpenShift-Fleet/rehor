import {
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Content,
  DescriptionList,
  DescriptionListDescription,
  DescriptionListGroup,
  DescriptionListTerm,
  Divider,
  Flex,
  FlexItem,
  Label,
  LabelGroup,
  SearchInput,
  ToggleGroup,
  ToggleGroupItem,
} from "@patternfly/react-core";
import { CompressIcon, DownloadIcon, ExpandIcon, TimesIcon } from "@patternfly/react-icons";
import JSZip from "jszip";
import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import { Link, useSearchParams } from "react-router-dom";
import { fetchCycleRuns, fetchCycleRunsByTask, fetchCycleRunTranscript } from "../api";
import CycleRunCard from "../components/CycleRunCard";
import Pagination from "../components/Pagination";
import { useWS } from "../hooks/useWebSocket";
import { parseTranscript } from "../transcript";
import type { CycleRun, TaskCycleGroup } from "../types";
import { displayKey, formatDuration, formatTokens, sourceUrl, timeAgo } from "../utils";

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadText(content: string, filename: string) {
  downloadBlob(new Blob([content], { type: "application/x-ndjson" }), filename);
}

async function downloadAllTranscripts(
  taskId: number | null,
  key: string | null,
  instanceId?: string,
) {
  const params: { task_id?: number | "none"; instance_id?: string; limit: number } = { limit: 100 };
  if (taskId != null) params.task_id = taskId;
  else if (!key) params.task_id = "none";
  if (instanceId) params.instance_id = instanceId;
  const res = await fetchCycleRuns(params);
  const runs: CycleRun[] = res.items || [];

  const zip = new JSZip();
  for (const run of runs) {
    try {
      const text = await fetchCycleRunTranscript(run.id);
      const ts = run.started_at.replace(/[:.]/g, "-").slice(0, 19);
      zip.file(`cycle-${run.id}-${run.cycle_type}-${ts}.jsonl`, text);
    } catch {
      // skip cycles without transcript
    }
  }

  const label = key || (taskId != null ? `task-${taskId}` : "orphan");
  const blob = await zip.generateAsync({ type: "blob" });
  downloadBlob(blob, `transcripts-${label}.zip`);
}

const transcriptCache = new Map<number, string>();

function Highlight({ text, search }: { text: string; search: string }) {
  if (!search) return <>{text}</>;
  const parts = text.split(new RegExp(`(${search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"));
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === search.toLowerCase() ? (
          <mark key={i} className="search-highlight">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

function TranscriptViewer({
  runId,
  onRequestFullscreen,
}: {
  runId: number;
  onRequestFullscreen?: () => void;
}) {
  const [transcript, setTranscript] = useState<string | null>(transcriptCache.get(runId) ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rawMode, setRawMode] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<number>>(() => {
    const cached = transcriptCache.get(runId);
    if (cached) {
      const largeIds = new Set<number>();
      parseTranscript(cached).forEach((e, i) => {
        if (e.isLarge) largeIds.add(i);
      });
      return largeIds;
    }
    return new Set();
  });
  const [showThinking, setShowThinking] = useState(false);
  const [search, setSearch] = useState("");

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const text = await fetchCycleRunTranscript(runId);
      transcriptCache.set(runId, text);
      setTranscript(text);
      const parsed = parseTranscript(text);
      const largeIds = new Set<number>();
      parsed.forEach((e, i) => {
        if (e.isLarge) largeIds.add(i);
      });
      setCollapsed(largeIds);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load transcript");
    } finally {
      setLoading(false);
    }
  };

  if (transcript === null && !loading && !error) {
    return (
      <Button variant="secondary" onClick={load}>
        Load Transcript
      </Button>
    );
  }
  if (loading) return <Content component="p">Loading transcript...</Content>;
  if (error)
    return (
      <Content
        component="p"
        style={{ color: "var(--pf-t--global--color--status--danger--default)" }}
      >
        {error}
      </Content>
    );
  if (transcript === null) return null;

  const entries = parseTranscript(transcript);
  const searchLower = search.toLowerCase();
  const indexed = entries.map((entry, index) => ({ entry, index }));
  let visible = showThinking
    ? indexed
    : indexed.filter(({ entry }) => entry.blockType !== "thinking");
  if (search) {
    visible = visible.filter(
      ({ entry }) =>
        entry.content.toLowerCase().includes(searchLower) ||
        entry.label.toLowerCase().includes(searchLower),
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
      <Flex
        alignItems={{ default: "alignItemsCenter" }}
        gap={{ default: "gapSm" }}
        style={{ marginBottom: "8px" }}
      >
        <FlexItem>
          <Label variant="outline">{visible.length} entries</Label>
        </FlexItem>
        <FlexItem style={{ flex: 1 }}>
          <SearchInput
            placeholder="Search transcript..."
            value={search}
            onChange={(_e, val) => setSearch(val)}
            onClear={() => setSearch("")}
            onFocus={() => onRequestFullscreen?.()}
          />
        </FlexItem>
        <FlexItem>
          <Button
            variant="plain"
            size="sm"
            onClick={() => downloadText(transcript, `cycle-${runId}.jsonl`)}
            title="Download transcript"
          >
            <DownloadIcon />
          </Button>
        </FlexItem>
        <FlexItem style={{ flexShrink: 0 }}>
          <ToggleGroup aria-label="View options">
            <ToggleGroupItem
              text="Thinking"
              isSelected={showThinking}
              onChange={() => {
                setShowThinking(!showThinking);
                setRawMode(false);
              }}
            />
            <ToggleGroupItem
              text="Raw"
              isSelected={rawMode}
              onChange={() => {
                setRawMode(!rawMode);
                setShowThinking(false);
              }}
            />
          </ToggleGroup>
        </FlexItem>
      </Flex>
      {rawMode ? (
        <pre className="transcript-raw">{transcript}</pre>
      ) : (
        <div className="transcript-messages">
          {entries.length === 0 ? (
            <Content component="p">
              No renderable messages in this transcript. Records may contain only metadata or an
              unsupported format. Use Raw or download to inspect.
            </Content>
          ) : visible.length === 0 ? (
            <Content component="p">
              No entries match the current search and Thinking filters.
            </Content>
          ) : null}
          {visible.map(({ entry, index }) => {
            const isCollapsed = collapsed.has(index) && !search;
            return (
              <div key={index} className={`transcript-line role-${entry.role}`}>
                <div
                  className="transcript-line-header"
                  onClick={() => entry.isLarge && toggleCollapse(index)}
                >
                  <span className="transcript-role">{entry.role}</span>
                  {entry.label && (
                    <span className="transcript-tool-name">
                      <Highlight text={entry.label} search={search} />
                    </span>
                  )}
                  {entry.isLarge && !search && (
                    <span className="transcript-toggle">
                      {collapsed.has(index) ? "[+]" : "[-]"}
                    </span>
                  )}
                </div>
                {!isCollapsed &&
                  (entry.blockType === "text" || entry.blockType === "thinking" ? (
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
                  ))}
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
  taskHref,
}: {
  taskHref: string | null;
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
    <Card
      isGlass
      className={fullscreen ? "detail-fullscreen" : ""}
      role="region"
      aria-label={`Cycle #${run.id} details`}
    >
      <CardHeader
        actions={{
          actions: (
            <Flex gap={{ default: "gapSm" }}>
              <FlexItem>
                <Button
                  variant="plain"
                  onClick={onToggleFullscreen}
                  title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
                >
                  {fullscreen ? <CompressIcon /> : <ExpandIcon />}
                </Button>
              </FlexItem>
              <FlexItem>
                <Button variant="plain" onClick={onClose}>
                  <TimesIcon />
                </Button>
              </FlexItem>
            </Flex>
          ),
        }}
      >
        <CardTitle>Cycle #{run.id}</CardTitle>
      </CardHeader>
      <CardBody>
        <DescriptionList isHorizontal isCompact>
          <DescriptionListGroup>
            <DescriptionListTerm>Task</DescriptionListTerm>
            <DescriptionListDescription>
              {taskHref ? <Link to={taskHref}>Open task</Link> : "No associated task"}
            </DescriptionListDescription>
          </DescriptionListGroup>
          <DescriptionListGroup>
            <DescriptionListTerm>Type</DescriptionListTerm>
            <DescriptionListDescription>
              <Label color="blue">{run.cycle_type.replace(/_/g, " ").toUpperCase()}</Label>
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
            <DescriptionListDescription title={run.started_at}>
              {timeAgo(run.started_at)}
            </DescriptionListDescription>
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
              <DescriptionListDescription>
                {formatTokens(run.tokens_used)}
              </DescriptionListDescription>
            </DescriptionListGroup>
          )}
        </DescriptionList>

        {Object.keys(progress).length > 0 && (
          <>
            <Divider style={{ margin: "16px 0" }} />
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
                      <div key={i}>
                        <code>{f}</code>
                      </div>
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
            <Divider style={{ margin: "16px 0" }} />
            <Content component="h4">Input Prompt</Content>
            <pre className="input-prompt-content">{run.input_prompt}</pre>
          </>
        )}

        <Divider style={{ margin: "16px 0" }} />
        <Content component="h4">Transcript</Content>
        {run.has_transcript ? (
          <TranscriptViewer
            runId={run.id}
            onRequestFullscreen={() => {
              if (!fullscreen) onToggleFullscreen();
            }}
          />
        ) : (
          <Content
            component="p"
            style={{ color: "var(--pf-t--global--text--color--subtle, var(--text-dim))" }}
          >
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
  const label = key || (group.task_id != null ? `Task #${group.task_id}` : "Orphan cycles");
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
    <Card
      isCompact
      isGlass
      isSelected={expanded}
      onClick={onClick}
      style={{ cursor: "pointer", marginBottom: "8px" }}
    >
      <CardHeader
        actions={{
          actions: (
            <Flex alignItems={{ default: "alignItemsCenter" }} gap={{ default: "gapSm" }}>
              {group.transcript_count > 0 && (
                <FlexItem>
                  <Button
                    variant="plain"
                    size="sm"
                    onClick={handleDownload}
                    isDisabled={downloading}
                    title="Download all transcripts as ZIP"
                  >
                    {downloading ? "..." : <DownloadIcon />}
                  </Button>
                </FlexItem>
              )}
              <FlexItem>
                <Label variant="outline">{group.cycle_count} cycles</Label>
              </FlexItem>
            </Flex>
          ),
        }}
      >
        <CardTitle>
          <Flex alignItems={{ default: "alignItemsCenter" }} gap={{ default: "gapSm" }}>
            <FlexItem>
              {group.task_id != null ? (
                <Link
                  to={`/${group.task_status === "archived" ? "archived" : "tasks"}?task_id=${group.task_id}`}
                  onClick={(event) => event.stopPropagation()}
                >
                  {label}
                </Link>
              ) : key ? (
                <a
                  href={url || "#"}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                >
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
        <Flex direction={{ default: "column" }} gap={{ default: "gapSm" }}>
          {group.title && (
            <FlexItem>
              <Content component="p" style={{ margin: 0 }}>
                {group.title}
              </Content>
            </FlexItem>
          )}
          <FlexItem>
            <LabelGroup>
              {group.repo && <Label variant="outline">{group.repo}</Label>}
              {group.total_tokens != null && (
                <Label variant="outline">{formatTokens(group.total_tokens)} tokens</Label>
              )}
              {group.transcript_count > 0 && (
                <Label variant="outline">{group.transcript_count} transcripts</Label>
              )}
              {group.last_cycle && (
                <Label variant="outline">last {timeAgo(group.last_cycle)}</Label>
              )}
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
  return "orphan";
}

function findRunGroup(run: CycleRun, groups: TaskCycleGroup[]): TaskCycleGroup | undefined {
  if (run.task_id != null) return groups.find((group) => group.task_id === run.task_id);
  const key = run.progress?.external_key;
  return groups.find(
    (group) =>
      (group.external_key || "") === (key || "") &&
      (group.task_id == null || (key && group.source_type === "jira")),
  );
}

export default function CycleRuns({ instanceId }: { instanceId?: string }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [groups, setGroups] = useState<TaskCycleGroup[]>([]);
  const [loadingGroups, setLoadingGroups] = useState(true);
  const [groupsError, setGroupsError] = useState(false);
  const [runs, setRuns] = useState<CycleRun[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [runsContext, setRunsContext] = useState("");
  const [selection, setSelection] = useState<{ key: string; run: CycleRun } | null>(null);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [revision, setRevision] = useState(0);
  const { onEvent } = useWS();
  const taskParam = searchParams.get("task_id");
  const cycleParam = searchParams.get("cycle");
  const externalKey = searchParams.get("external_key");
  const taskId = taskParam && taskParam !== "none" ? Number(taskParam) : null;
  const cycleId = cycleParam !== null ? Number(cycleParam) : null;
  const validTask =
    taskParam === null ||
    taskParam === "none" ||
    (Number.isSafeInteger(taskId) && (taskId ?? 0) > 0);
  const validCycle = cycleParam === null || (Number.isSafeInteger(cycleId) && (cycleId ?? 0) > 0);
  const context = JSON.stringify([taskParam, cycleParam, externalKey, instanceId, offset]);
  const selectedRun = selection?.key === context ? selection.run : null;
  const scopeGroup = groups.find((g) =>
    taskId != null
      ? g.task_id === taskId
      : taskParam === "none" && g.task_id == null && (g.external_key || "") === (externalKey || ""),
  );
  const selectedGroup =
    scopeGroup ||
    (taskParam !== "none" && selectedRun ? findRunGroup(selectedRun, groups) : undefined);
  const expandedKey = scopeGroup
    ? groupKey(scopeGroup)
    : selectedGroup
      ? groupKey(selectedGroup)
      : taskId != null
        ? `t:${taskId}`
        : taskParam === "none"
          ? externalKey
            ? `k:${externalKey}`
            : "orphan"
          : undefined;
  const associatedId =
    taskParam === "none" ? null : (taskId ?? selectedRun?.task_id ?? selectedGroup?.task_id);
  const taskHref =
    associatedId != null
      ? `/${selectedGroup?.task_status === "archived" ? "archived" : "tasks"}?task_id=${associatedId}`
      : null;
  const visibleGroups =
    taskParam !== null ? groups.filter((g) => groupKey(g) === expandedKey) : groups;

  // biome-ignore lint/correctness/useExhaustiveDependencies: changing URL/bot identity resets presentation, not history data.
  useEffect(() => {
    setOffset(0);
    setFullscreen(false);
  }, [taskParam, cycleParam, externalKey, instanceId]);

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  useEffect(
    () =>
      onEvent((event) => {
        if (event.type === "cycle_run_added") setRevision((value) => value + 1);
      }),
    [onEvent],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision refreshes groups after live cycle events and explicit retries.
  useEffect(() => {
    let current = true;
    setLoadingGroups(true);
    setGroupsError(false);
    fetchCycleRunsByTask({ instance_id: instanceId })
      .then((data) => {
        if (!Array.isArray(data?.items)) throw new Error("Invalid cycle groups");
        if (current) setGroups(data.items);
      })
      .catch(() => {
        if (current) setGroupsError(true);
      })
      .finally(() => {
        if (current) setLoadingGroups(false);
      });
    return () => {
      current = false;
    };
  }, [instanceId, revision]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision refreshes the selected history after cycle events and retries.
  useEffect(() => {
    let current = true;
    setRunsError(null);
    if (!validTask || !validCycle) {
      setRunsError("Invalid task or cycle link.");
      return;
    }
    if (taskParam === null && cycleId === null) {
      setRuns([]);
      setSelection(null);
      return;
    }
    setLoadingRuns(true);
    const load = async () => {
      const filter = {
        task_id: taskParam === "none" ? ("none" as const) : (taskId ?? undefined),
        external_key: taskParam === "none" ? (externalKey ?? "") : undefined,
        instance_id: instanceId,
      };
      let selected: CycleRun | null = null;
      if (cycleId !== null) {
        const exact = await fetchCycleRuns({ ...filter, run_id: cycleId, limit: 1 });
        selected = exact.items?.find((run: CycleRun) => run.id === cycleId) ?? null;
        if (!selected) throw new Error("Requested cycle was not found in this history.");
      }
      const resolvedGroup = selected && findRunGroup(selected, groups);
      const resolvedId =
        taskParam === "none" ? null : (taskId ?? selected?.task_id ?? resolvedGroup?.task_id);
      const page = await fetchCycleRuns({
        ...filter,
        task_id: resolvedId ?? "none",
        external_key:
          resolvedId == null
            ? (filter.external_key ?? selected?.progress?.external_key ?? "")
            : undefined,
        limit: 50,
        offset,
      });
      if (!Array.isArray(page.items) || typeof page.total !== "number")
        throw new Error("Invalid cycle history");
      if (current) {
        setRuns(page.items);
        setTotal(page.total);
        setRunsContext(context);
        setSelection(selected ? { key: context, run: selected } : null);
      }
    };
    load()
      .catch((error) => {
        if (current) setRunsError(error.message || "Could not load cycles.");
      })
      .finally(() => {
        if (current) setLoadingRuns(false);
      });
    return () => {
      current = false;
    };
  }, [
    taskParam,
    taskId,
    cycleId,
    externalKey,
    instanceId,
    offset,
    revision,
    context,
    validTask,
    validCycle,
    groups,
  ]);

  const showAll = () => {
    const params = new URLSearchParams(searchParams);
    for (const name of ["task_id", "cycle", "external_key"]) params.delete(name);
    setSearchParams(params);
  };
  const handleGroupClick = (group: TaskCycleGroup) => {
    if (expandedKey === groupKey(group)) {
      showAll();
      return;
    }
    const params = new URLSearchParams(searchParams);
    params.delete("cycle");
    params.delete("external_key");
    params.set("task_id", group.task_id != null ? String(group.task_id) : "none");
    if (group.task_id == null) params.set("external_key", group.external_key || "");
    setSearchParams(params);
  };
  const handleSelectRun = (run: CycleRun) => {
    const params = new URLSearchParams(searchParams);
    params.set("cycle", String(run.id));
    setSearchParams(params);
  };
  const handleClose = () => {
    const params = new URLSearchParams(searchParams);
    params.delete("cycle");
    setSearchParams(params);
    setFullscreen(false);
  };
  const detail = selectedRun && (
    <CycleRunDetail
      run={selectedRun}
      taskHref={taskHref}
      onClose={handleClose}
      fullscreen={fullscreen}
      onToggleFullscreen={() => setFullscreen((value) => !value)}
    />
  );
  if (fullscreen && selectedRun) return detail;

  return (
    <div className="split-layout">
      <div className="split-main">
        {(taskParam !== null || cycleParam !== null) && (
          <div className="controls">
            <Button variant="secondary" onClick={showAll}>
              Show all cycles
            </Button>
            {validTask && taskId != null && !scopeGroup && (
              <Link to={`/tasks?task_id=${taskId}`}>Open task</Link>
            )}
          </div>
        )}
        {groupsError && (
          <p role="alert">
            Could not load cycle groups.{" "}
            <Button variant="link" onClick={() => setRevision((value) => value + 1)}>
              Retry cycles
            </Button>
          </p>
        )}
        {runsError && (
          <p role="alert">
            {runsError}{" "}
            <Button variant="link" onClick={() => setRevision((value) => value + 1)}>
              Retry cycle history
            </Button>
          </p>
        )}
        {loadingGroups && <p role="status">Loading cycle groups…</p>}
        <div className="task-group-list">
          {!loadingGroups && !groupsError && visibleGroups.length === 0 && (
            <div className="empty-state">
              {taskParam !== null ? "No cycles recorded for this task." : "No cycle runs found"}
            </div>
          )}
          {visibleGroups.map((group) => {
            const key = groupKey(group);
            const expanded = key === expandedKey;
            const groupTaskHref =
              group.task_id != null
                ? `/${group.task_status === "archived" ? "archived" : "tasks"}?task_id=${group.task_id}`
                : undefined;
            return (
              <div key={key}>
                <TaskGroupCard
                  group={group}
                  expanded={expanded}
                  onClick={() => handleGroupClick(group)}
                  instanceId={instanceId}
                />
                {expanded && (
                  <div className="task-group-cycles">
                    {(loadingRuns || runsContext !== context) && !runsError ? (
                      <p role="status">Loading cycles…</p>
                    ) : (
                      !runsError && (
                        <>
                          {runs.map((run) => (
                            <CycleRunCard
                              key={run.id}
                              run={run}
                              taskHref={groupTaskHref}
                              selected={selectedRun?.id === run.id}
                              onClick={() => handleSelectRun(run)}
                            />
                          ))}
                          <Pagination
                            total={total}
                            limit={50}
                            offset={offset}
                            onChange={setOffset}
                          />
                        </>
                      )
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {detail && <div className="split-detail">{detail}</div>}
    </div>
  );
}
