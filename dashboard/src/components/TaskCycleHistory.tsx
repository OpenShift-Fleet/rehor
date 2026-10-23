import { Button, Content, Flex, FlexItem, Label, List, ListItem } from "@patternfly/react-core";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchCycleRuns } from "../api";
import { useWS } from "../hooks/useWebSocket";
import type { CycleRun } from "../types";
import { timeAgo } from "../utils";
import Pagination from "./Pagination";

const LIMIT = 5;

export default function TaskCycleHistory({ taskId }: { taskId: number }) {
  const [runs, setRuns] = useState<CycleRun[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const { onEvent } = useWS();

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision retries failed reads and refreshes history after cycle events.
  useEffect(() => {
    let current = true;
    setRuns([]);
    setStatus("loading");
    fetchCycleRuns({ task_id: taskId, limit: LIMIT, offset })
      .then((data) => {
        if (!Array.isArray(data.items) || typeof data.total !== "number")
          throw new Error("Invalid cycle history");
        if (current) {
          setRuns(data.items);
          setTotal(data.total);
          setStatus("ready");
        }
      })
      .catch(() => {
        if (current) setStatus("error");
      });
    return () => {
      current = false;
    };
  }, [taskId, offset, revision]);

  useEffect(
    () =>
      onEvent((event) => {
        if (
          event.type === "cycle_run_added" &&
          (event.data.task_id == null || event.data.task_id === taskId)
        ) {
          setRevision((value) => value + 1);
        }
      }),
    [onEvent, taskId],
  );

  return (
    <section aria-label="Cycle history">
      <Content component="h4">Cycle history</Content>
      {status === "loading" && <p role="status">Loading cycle history…</p>}
      {status === "error" && (
        <>
          <p role="alert">Could not load cycle history.</p>
          <Button variant="secondary" onClick={() => setRevision((value) => value + 1)}>
            Retry cycle history
          </Button>
        </>
      )}
      {status === "ready" && (
        <>
          {runs.length === 0 ? (
            <p>No cycles recorded for this task.</p>
          ) : (
            <List isPlain>
              {runs.map((run) => (
                <ListItem key={run.id}>
                  <Flex
                    direction={{ default: "column" }}
                    gap={{ default: "gapXs" }}
                    style={{ marginBottom: "12px" }}
                  >
                    <FlexItem>
                      <Link to={`/cycles?task_id=${taskId}&cycle=${run.id}`}>
                        Open cycle #{run.id}
                      </Link>
                    </FlexItem>
                    <FlexItem>
                      <Label variant="outline">{run.cycle_type.replace(/_/g, " ")}</Label>{" "}
                      <span title={run.started_at}>{timeAgo(run.started_at)}</span>
                      {run.instance_id && ` · ${run.instance_id}`}
                    </FlexItem>
                    {(run.progress?.last_step || run.progress?.summary) && (
                      <FlexItem>
                        <Content component="small">
                          {String(run.progress.last_step || run.progress.summary)}
                        </Content>
                      </FlexItem>
                    )}
                  </Flex>
                </ListItem>
              ))}
            </List>
          )}
          <Pagination total={total} limit={LIMIT} offset={offset} onChange={setOffset} />
        </>
      )}
      <Link to={`/cycles?task_id=${taskId}`}>View all cycles for this task</Link>
    </section>
  );
}
