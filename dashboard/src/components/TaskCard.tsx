import type { Task } from '../types';
import { timeAgo, sourceUrl, displayKey } from '../utils';

interface Props {
  task: Task;
  selected?: boolean;
  onClick?: () => void;
}

const statusLabels: Record<string, string> = {
  in_progress: 'In Progress',
  pr_open: 'PR Open',
  pr_changes: 'Changes Requested',
  done: 'Done',
  paused: 'Paused',
  archived: 'Archived',
};

const sourceTypeColors: Record<string, string> = {
  jira: 'blue',
  github: 'dark',
  gitlab: 'orange',
  scheduled: 'purple',
  manual: 'dim',
};

export default function TaskCard({ task, selected, onClick }: Props) {
  const step = task.metadata?.last_step;
  const url = sourceUrl(task);
  const key = displayKey(task);
  const firstArtifact = task.artifacts?.[0];

  return (
    <div
      className={`task-card status-${task.status}${selected ? ' selected' : ''}`}
      onClick={onClick}
    >
      <div className="task-card-header">
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="task-jira-key"
            onClick={(e) => e.stopPropagation()}
          >
            {key}
          </a>
        ) : (
          <span className="task-jira-key">{key}</span>
        )}
        {task.source_type && task.source_type !== 'jira' && (
          <span className={`source-type-badge ${sourceTypeColors[task.source_type] || 'dim'}`}>
            {task.source_type}
          </span>
        )}
        <span className={`status-badge ${task.status}`}>
          {statusLabels[task.status] || task.status}
        </span>
      </div>
      {task.title && <div className="task-card-title">{task.title}</div>}
      <div className="task-card-meta">
        <span className="task-repo">{task.repo}</span>
        {firstArtifact && (
          <a
            href={firstArtifact.url}
            target="_blank"
            rel="noopener noreferrer"
            className="task-pr"
            onClick={(e) => e.stopPropagation()}
          >
            {firstArtifact.name}
          </a>
        )}
        <span className="task-created" title={task.created_at}>
          {timeAgo(task.created_at)}
        </span>
        {task.last_addressed && (
          <span className="task-activity" title={task.last_addressed}>
            active {timeAgo(task.last_addressed)}
          </span>
        )}
      </div>
      {step && <div className="task-step">Step: {step}</div>}
      {task.instance_id && (
        <span className="task-instance" title={`Instance: ${task.instance_id}`}>
          {task.instance_id}
        </span>
      )}
      {task.paused_reason && (
        <div className="task-paused-reason">{task.paused_reason}</div>
      )}
      {task.slack_notification && (
        <div className="task-slack-notif" title={`${task.slack_notification.event_type}: ${task.slack_notification.message}`}>
          <span className="slack-icon">🔔</span>
          <span className="slack-event">{task.slack_notification.event_type.replace(/_/g, ' ')}</span>
          <span className="slack-time">{timeAgo(task.slack_notification.sent_at)}</span>
        </div>
      )}
    </div>
  );
}
