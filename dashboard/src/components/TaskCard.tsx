import {
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Content,
  Flex,
  FlexItem,
  Icon,
  Label,
  LabelGroup,
} from "@patternfly/react-core";
import { ExclamationTriangleIcon } from "@patternfly/react-icons";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { Task } from "../types";
import { displayKey, sourceUrl, timeAgo } from "../utils";

interface Props {
  task: Task;
  selected?: boolean;
  onClick?: () => void;
  query?: string;
}

const statusLabels: Record<string, string> = {
  in_progress: "In Progress",
  pr_open: "PR Open",
  pr_changes: "Changes Requested",
  done: "Done",
  paused: "Paused",
  archived: "Archived",
};

const statusColors: Record<string, "blue" | "green" | "orange" | "red" | "purple" | "grey"> = {
  in_progress: "blue",
  pr_open: "green",
  pr_changes: "orange",
  done: "grey",
  paused: "purple",
  archived: "grey",
};

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>;
  const pattern = new RegExp(query.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  const parts: ReactNode[] = [];
  let start = 0;
  for (const match of text.matchAll(pattern)) {
    parts.push(text.slice(start, match.index));
    parts.push(
      <mark key={match.index} className="search-highlight">
        {match[0]}
      </mark>,
    );
    start = match.index + match[0].length;
  }
  return (
    <>
      {parts}
      {text.slice(start)}
    </>
  );
}

export default function TaskCard({ task, selected, onClick, query = "" }: Props) {
  const url = sourceUrl(task);
  const key = displayKey(task);
  const firstArtifact = task.artifacts?.[0];

  return (
    <Card
      isCompact
      isGlass
      isSelected={selected}
      onClick={onClick}
      style={{
        cursor: "pointer",
        borderLeft: `3px solid ${task.status === "in_progress" ? "var(--accent)" : task.status === "pr_changes" ? "var(--yellow)" : task.status === "pr_open" ? "var(--green)" : task.status === "paused" ? "var(--purple)" : "transparent"}`,
      }}
    >
      <CardHeader
        actions={{
          actions: (
            <Label color={statusColors[task.status] || "grey"}>
              <Highlight text={statusLabels[task.status] || task.status} query={query} />
            </Label>
          ),
        }}
      >
        <CardTitle>
          {query ? (
            <Button
              variant="link"
              isInline
              onClick={(event) => {
                event.stopPropagation();
                onClick?.();
              }}
            >
              <Highlight text={key} query={query} />
            </Button>
          ) : url ? (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              style={{ fontWeight: 600 }}
            >
              <Highlight text={key} query={query} />
            </a>
          ) : (
            <span style={{ fontWeight: 600 }}>
              <Highlight text={key} query={query} />
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardBody>
        <Flex direction={{ default: "column" }} gap={{ default: "gapSm" }}>
          {task.title && (
            <FlexItem>
              <Content component="p" style={{ margin: 0 }}>
                <Highlight text={task.title} query={query} />
              </Content>
            </FlexItem>
          )}
          <FlexItem>
            <LabelGroup>
              <Label variant="outline">
                <Highlight text={task.repo || ""} query={query} />
              </Label>
              {firstArtifact && (
                <span onClick={(e) => e.stopPropagation()}>
                  <Label color="blue" href={firstArtifact.url}>
                    {firstArtifact.name}
                  </Label>
                </span>
              )}
              <Label variant="outline">{timeAgo(task.created_at)}</Label>
              {task.last_addressed && (
                <Label variant="outline">active {timeAgo(task.last_addressed)}</Label>
              )}
            </LabelGroup>
          </FlexItem>
          <FlexItem>
            <Link to={`/cycles?task_id=${task.id}`} onClick={(event) => event.stopPropagation()}>
              View cycles
            </Link>
          </FlexItem>
          {task.instance_id && (
            <FlexItem>
              <Label variant="outline" color="grey">
                <Highlight text={task.instance_id} query={query} />
              </Label>
            </FlexItem>
          )}
          {task.paused_reason && (
            <FlexItem>
              <Content
                component="p"
                style={{ margin: 0, color: "var(--yellow)", fontSize: "13px" }}
              >
                <Icon status="warning" size="sm">
                  <ExclamationTriangleIcon />
                </Icon>{" "}
                <Highlight text={task.paused_reason} query={query} />
              </Content>
            </FlexItem>
          )}
          {task.slack_notification && (
            <FlexItem>
              <Label variant="outline" icon={<span>🔔</span>}>
                {task.slack_notification.event_type.replace(/_/g, " ")} ·{" "}
                {timeAgo(task.slack_notification.sent_at)}
              </Label>
            </FlexItem>
          )}
        </Flex>
      </CardBody>
    </Card>
  );
}
