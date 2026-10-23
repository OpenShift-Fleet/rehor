import {
  Button,
  MenuToggle,
  type MenuToggleElement,
  Select,
  SelectList,
  SelectOption,
} from "@patternfly/react-core";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { deleteTask, fetchTasks, pauseTask, unpauseTask } from "../api";
import ConfirmDialog from "../components/ConfirmDialog";
import DetailPanel from "../components/DetailPanel";
import Pagination from "../components/Pagination";
import TaskCard from "../components/TaskCard";
import { useWS } from "../hooks/useWebSocket";
import type { Task } from "../types";

const STATUS_OPTIONS = [
  { value: "", label: "All" },
  { value: "in_progress", label: "In Progress" },
  { value: "pr_open", label: "PR Open" },
  { value: "pr_changes", label: "PR Changes" },
  { value: "paused", label: "Paused" },
  { value: "done", label: "Done" },
];

const LIMIT = 20;

type DialogState =
  | { action: "pause"; key: string }
  | { action: "unpause"; key: string }
  | { action: "archive"; key: string; sourceType: string }
  | null;

export default function Tasks({ instanceId }: { instanceId?: string }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<Task | null>(null);
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [error, setError] = useState<string | null>(null);

  const { onEvent } = useWS();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const query = (searchParams.get("q") || "").trim();
  const isSearch = query.length > 0;
  // Old bookmarks may still select Archived; Tasks must never request that status.
  const requestedStatus = searchParams.get("status") || "";
  const status = requestedStatus === "archived" ? "" : requestedStatus;
  const page = Number(searchParams.get("page") || 1);
  const offset =
    Number.isSafeInteger(page) && page > 0 && Number.isSafeInteger((page - 1) * LIMIT)
      ? (page - 1) * LIMIT
      : 0;
  const changePage = (newOffset: number) => {
    const params = new URLSearchParams(searchParams);
    if (newOffset) params.set("page", String(newOffset / LIMIT + 1));
    else params.delete("page");
    setSearchParams(params);
  };
  const targetId = Number(searchParams.get("task_id"));
  const taskId = Number.isSafeInteger(targetId) && targetId > 0 ? targetId : undefined;

  const closeSelection = () => {
    setSelected(null);
    if (taskId) {
      const params = new URLSearchParams(searchParams);
      params.delete("task_id");
      params.delete("page");
      setSearchParams(params);
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: changing task/filter/page context deliberately clears local selection.
  useEffect(() => {
    setSelected(null);
  }, [taskId, query, status, offset, instanceId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly refreshes live data after events, actions and retries.
  useEffect(() => {
    let current = true;
    const controller = new AbortController();
    setTasks([]);
    setTotal(0);
    setLoadError(false);
    if (isSearch && query.length < 2) {
      setLoading(false);
      return;
    }
    setLoading(true);
    fetchTasks(
      {
        q: isSearch ? query : undefined,
        task_id: taskId,
        status: status || undefined,
        exclude_status: !taskId || isSearch ? "archived" : undefined,
        limit: LIMIT,
        offset: taskId ? 0 : offset,
        instance_id: instanceId,
      },
      controller.signal,
    )
      .then((res) => {
        if (!current) return;
        if (!Array.isArray(res.items) || typeof res.total !== "number")
          throw new Error("Invalid task response");
        if (taskId && !isSearch && res.items[0]?.status === "archived") {
          navigate(`/archived?task_id=${taskId}`, { replace: true });
          return;
        }
        if (!taskId && res.total > 0 && offset >= res.total) {
          const params = new URLSearchParams(searchParams);
          params.set("page", String(Math.ceil(res.total / LIMIT)));
          setSearchParams(params, { replace: true });
          return;
        }
        setTasks(res.items);
        setTotal(res.total);
        setSelected((previous) =>
          taskId
            ? (res.items[0] ?? null)
            : (res.items.find((t: Task) => t.id === previous?.id) ?? null),
        );
      })
      .catch(() => {
        if (current) setLoadError(true);
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [
    query,
    isSearch,
    status,
    offset,
    instanceId,
    taskId,
    navigate,
    searchParams,
    setSearchParams,
    revision,
  ]);

  useEffect(() => {
    return onEvent((event) => {
      if (
        event.type === "task_added" ||
        event.type === "task_updated" ||
        event.type === "task_archived"
      ) {
        setRevision((value) => value + 1);
      }
    });
  }, [onEvent]);

  const runAction = async (action: () => Promise<Response>) => {
    const res = await action();
    if (!res.ok) {
      let msg = `Request failed (${res.status})`;
      try {
        const body = await res.json();
        if (body?.error) msg = body.error;
      } catch {
        /* ignore non-JSON */
      }
      setError(msg);
      return false;
    }
    return true;
  };

  const handleDialogConfirm = async (inputValue?: string) => {
    if (!dialog) return;
    let ok = false;
    switch (dialog.action) {
      case "pause":
        ok = await runAction(() => pauseTask(dialog.key, inputValue?.trim() || undefined));
        break;
      case "unpause":
        ok = await runAction(() => unpauseTask(dialog.key));
        break;
      case "archive":
        ok = await runAction(() => deleteTask(dialog.key, dialog.sourceType));
        break;
    }
    setDialog(null);
    if (ok) {
      setSelected(null);
      setRevision((value) => value + 1);
    }
  };

  const dialogProps = () => {
    if (!dialog) return { title: "", message: "" };
    switch (dialog.action) {
      case "pause":
        return {
          title: "Pause task",
          message: `Pause ${dialog.key}? The bot will skip it until unpaused.`,
          confirmLabel: "Pause",
          inputLabel: "Reason (optional)",
          inputPlaceholder: "e.g. Waiting for design review",
        };
      case "unpause":
        return {
          title: "Unpause task",
          message: `Unpause ${dialog.key}? The bot may pick it up again.`,
          confirmLabel: "Unpause",
        };
      case "archive":
        return {
          title: "Archive task",
          message: `Manually archive ${dialog.key}? The bot will stop tracking it; its outcome remains unreported.`,
          confirmLabel: "Archive",
          variant: "danger" as const,
        };
    }
  };

  const currentLabel = STATUS_OPTIONS.find((o) => o.value === status)?.label || "All";

  return (
    <div className="split-layout">
      <div className="split-main">
        <div className="controls">
          {taskId ? (
            <Button type="button" variant="secondary" onClick={closeSelection}>
              {isSearch ? "Show search results" : "Show all tasks"}
            </Button>
          ) : (
            <Select
              isOpen={isFilterOpen}
              selected={status}
              onSelect={(_e, val) => {
                const params = new URLSearchParams(searchParams);
                if (val) params.set("status", String(val));
                else params.delete("status");
                params.delete("page");
                setSearchParams(params);
                setIsFilterOpen(false);
              }}
              onOpenChange={setIsFilterOpen}
              toggle={(toggleRef: React.Ref<MenuToggleElement>) => (
                <MenuToggle
                  ref={toggleRef}
                  onClick={() => setIsFilterOpen(!isFilterOpen)}
                  isExpanded={isFilterOpen}
                >
                  {currentLabel}
                </MenuToggle>
              )}
            >
              <SelectList>
                {STATUS_OPTIONS.map((o) => (
                  <SelectOption key={o.value} value={o.value}>
                    {o.label}
                  </SelectOption>
                ))}
              </SelectList>
            </Select>
          )}
        </div>
        {loading && <p role="status">Loading tasks…</p>}
        {loadError && (
          <div role="alert">
            Could not load tasks.{" "}
            <Button variant="secondary" onClick={() => setRevision((value) => value + 1)}>
              Retry tasks
            </Button>
          </div>
        )}
        {!loading && !loadError && isSearch && query.length < 2 && (
          <p role="status">Type at least 2 characters.</p>
        )}
        {!loading && !loadError && isSearch && query.length >= 2 && (
          <p role="status">
            {total} matching task{total === 1 ? "" : "s"}
          </p>
        )}
        <section className="card-grid" aria-label="Task results" aria-busy={loading}>
          {!loading && !loadError && (!isSearch || query.length >= 2) && tasks.length === 0 && (
            <div className="empty-state">No tasks found</div>
          )}
          {tasks.map((t) => (
            <TaskCard
              key={t.id}
              task={t}
              query={isSearch ? query : undefined}
              selected={selected?.id === t.id}
              onClick={() => setSelected(t)}
            />
          ))}
        </section>
        {!loading && !loadError && (
          <Pagination total={total} limit={LIMIT} offset={offset} onChange={changePage} />
        )}
      </div>
      {selected && (
        <div className="split-detail">
          <DetailPanel
            type="task"
            task={selected}
            onClose={closeSelection}
            onDelete={(key) =>
              setDialog({ action: "archive", key, sourceType: selected.source_type })
            }
            onPause={(key) => setDialog({ action: "pause", key })}
            onUnpause={(key) => setDialog({ action: "unpause", key })}
          />
        </div>
      )}
      <ConfirmDialog
        open={dialog !== null}
        onCancel={() => setDialog(null)}
        onConfirm={handleDialogConfirm}
        {...dialogProps()}
      />
      <ConfirmDialog
        open={error !== null}
        title="Error"
        message={error || ""}
        confirmLabel="OK"
        onConfirm={() => setError(null)}
        onCancel={() => setError(null)}
      />
    </div>
  );
}
