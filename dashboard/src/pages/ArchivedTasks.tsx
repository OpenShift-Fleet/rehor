import { Button, Content, Label } from "@patternfly/react-core";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { fetchTasks, unarchiveTask } from "../api";
import ConfirmDialog from "../components/ConfirmDialog";
import DetailPanel from "../components/DetailPanel";
import Pagination from "../components/Pagination";
import TaskCard from "../components/TaskCard";
import { useWS } from "../hooks/useWebSocket";
import type { Task } from "../types";

const LIMIT = 20;

export default function ArchivedTasks({ instanceId }: { instanceId?: string }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<Task | null>(null);
  const [restoreKey, setRestoreKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { onEvent } = useWS();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const query = (searchParams.get("q") || "").trim();
  const isSearch = query.length > 0;
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
  }, [taskId, query, offset, instanceId]);

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
        status: taskId && !isSearch ? undefined : "archived",
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
        if (taskId && !isSearch && res.items[0] && res.items[0].status !== "archived") {
          navigate(`/tasks?task_id=${taskId}`, { replace: true });
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

  const handleConfirmRestore = async () => {
    if (!restoreKey) return;
    const res = await unarchiveTask(restoreKey);
    setRestoreKey(null);
    if (!res.ok) {
      let msg = `Request failed (${res.status})`;
      try {
        const body = await res.json();
        if (body?.error) msg = body.error;
      } catch {
        /* ignore non-JSON */
      }
      setError(msg);
      return;
    }
    setSelected(null);
    setRevision((value) => value + 1);
  };

  return (
    <div className="split-layout">
      <div className="split-main">
        <div style={{ marginBottom: "16px" }}>
          {taskId && (
            <Button type="button" variant="secondary" onClick={closeSelection}>
              {isSearch ? "Show search results" : "Show all archived tasks"}
            </Button>
          )}
          {!loading && !loadError && (!isSearch || query.length >= 2) && (
            <Label variant="outline" role="status">
              {total}
              {isSearch ? " matching" : ""} archived task{total !== 1 ? "s" : ""}
            </Label>
          )}
        </div>
        {loading && <p role="status">Loading archived tasks…</p>}
        {loadError && (
          <div role="alert">
            Could not load archived tasks.{" "}
            <Button variant="secondary" onClick={() => setRevision((value) => value + 1)}>
              Retry archived tasks
            </Button>
          </div>
        )}
        {!loading && !loadError && isSearch && query.length < 2 && (
          <p role="status">Type at least 2 characters.</p>
        )}
        <section className="card-grid" aria-label="Archived task results" aria-busy={loading}>
          {!loading && !loadError && (!isSearch || query.length >= 2) && tasks.length === 0 && (
            <Content
              component="p"
              style={{ color: "var(--pf-t--global--text--color--subtle, var(--text-dim))" }}
            >
              No archived tasks
            </Content>
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
            onUnarchive={(key) => setRestoreKey(key)}
          />
        </div>
      )}
      <ConfirmDialog
        open={restoreKey !== null}
        title="Restore task"
        message={`Restore ${restoreKey}? It will become active again.`}
        confirmLabel="Restore"
        onConfirm={handleConfirmRestore}
        onCancel={() => setRestoreKey(null)}
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
