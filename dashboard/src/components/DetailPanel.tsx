import type { Task, Memory } from '../types';
import { timeAgo, sourceUrl, displayKey } from '../utils';

interface MemoryDetailProps {
  type: 'memory';
  memory: Memory;
  onClose: () => void;
  onDelete: (id: number) => void;
}

interface TaskDetailProps {
  type: 'task';
  task: Task;
  onClose: () => void;
  onDelete?: (key: string) => void;
  onUnarchive?: (key: string) => void;
  onPause?: (key: string) => void;
  onUnpause?: (key: string) => void;
}

type Props = MemoryDetailProps | TaskDetailProps;

const categoryColors: Record<string, string> = {
  learning: 'green',
  review_feedback: 'yellow',
  codebase_pattern: 'blue',
};

export default function DetailPanel(props: Props) {
  if (props.type === 'memory') {
    return <MemoryDetail {...props} />;
  }
  return <TaskDetail {...props} />;
}

function MemoryDetail({ memory, onClose, onDelete }: Omit<MemoryDetailProps, 'type'>) {
  const badgeClass = categoryColors[memory.category] || 'green';
  const prUrl = memory.metadata?.pr_url;

  return (
    <div className="detail-panel">
      <div className="detail-header">
        <h3>{memory.title}</h3>
        <button className="detail-close" onClick={onClose}>X</button>
      </div>
      <div className="detail-body">
        <pre className="detail-content">{memory.content}</pre>

        <div className="detail-meta-grid">
          <div className="detail-meta-item">
            <span className="detail-label">Category</span>
            <span className={`category-badge ${badgeClass}`}>
              {memory.category.replace(/_/g, ' ')}
            </span>
          </div>
          {memory.repo && (
            <div className="detail-meta-item">
              <span className="detail-label">Repo</span>
              <span>{memory.repo}</span>
            </div>
          )}
          {displayKey(memory) && (
            <div className="detail-meta-item">
              <span className="detail-label">Source</span>
              <a href={sourceUrl(memory) || '#'} target="_blank" rel="noopener noreferrer">
                {displayKey(memory)}
              </a>
            </div>
          )}
          {prUrl && (
            <div className="detail-meta-item">
              <span className="detail-label">PR</span>
              <a href={prUrl} target="_blank" rel="noopener noreferrer">{prUrl}</a>
            </div>
          )}
          {memory.similarity != null && (
            <div className="detail-meta-item">
              <span className="detail-label">Similarity</span>
              <span className="similarity-score">{(memory.similarity * 100).toFixed(1)}%</span>
            </div>
          )}
          <div className="detail-meta-item">
            <span className="detail-label">Created</span>
            <span title={memory.created_at}>{timeAgo(memory.created_at)}</span>
          </div>
          <div className="detail-meta-item">
            <span className="detail-label">ID</span>
            <span>{memory.id}</span>
          </div>
        </div>

        {memory.tags.length > 0 && (
          <div className="detail-tags">
            {memory.tags.map((t) => (
              <span key={t} className="tag">{t}</span>
            ))}
          </div>
        )}

        <button className="btn-delete" onClick={() => onDelete(memory.id)}>
          Delete Memory
        </button>
      </div>
    </div>
  );
}

function TaskDetail({
  task,
  onClose,
  onDelete,
  onUnarchive,
  onPause,
  onUnpause,
}: Omit<TaskDetailProps, 'type'>) {
  const meta = task.metadata || {};
  const prs: Array<{ repo: string; number: number; url: string; host: string }> =
    meta.prs || [];
  const repos: string[] = meta.repos || [task.repo];
  const key = displayKey(task);
  const url = sourceUrl(task);
  const artifacts = task.artifacts || [];
  const isActive =
    task.status === 'in_progress' ||
    task.status === 'pr_open' ||
    task.status === 'pr_changes';

  const statusLabels: Record<string, string> = {
    in_progress: 'In Progress',
    pr_open: 'PR Open',
    pr_changes: 'Changes Requested',
    done: 'Done',
    paused: 'Paused',
    archived: 'Archived',
  };

  return (
    <div className="detail-panel">
      <div className="detail-header">
        <h3>
          {url ? (
            <a href={url} target="_blank" rel="noopener noreferrer">{key}</a>
          ) : (
            <span>{key}</span>
          )}
          {task.title && <> &mdash; {task.title}</>}
        </h3>
        <button className="detail-close" onClick={onClose}>X</button>
      </div>
      <div className="detail-body">
        <div className="detail-meta-grid">
          <div className="detail-meta-item">
            <span className="detail-label">Status</span>
            <span className={`status-badge ${task.status}`}>
              {statusLabels[task.status] || task.status}
            </span>
          </div>
          <div className="detail-meta-item">
            <span className="detail-label">Repo(s)</span>
            <span>{repos.join(', ')}</span>
          </div>
          <div className="detail-meta-item">
            <span className="detail-label">Branch</span>
            <code className="mono">{task.branch}</code>
          </div>

          {artifacts.length > 0 ? (
            <div className="detail-meta-item">
              <span className="detail-label">Artifacts</span>
              <div>
                {artifacts.map((a, i) => (
                  <div key={i}>
                    <a href={a.url} target="_blank" rel="noopener noreferrer">
                      {a.name}
                    </a>
                    {a.type && <span className="artifact-type"> ({a.type})</span>}
                  </div>
                ))}
              </div>
            </div>
          ) : prs.length > 0 ? (
            <div className="detail-meta-item">
              <span className="detail-label">PRs</span>
              <div>
                {prs.map((pr, i) => (
                  <div key={i}>
                    <a href={pr.url} target="_blank" rel="noopener noreferrer">
                      {pr.repo} #{pr.number}
                    </a>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="detail-meta-item">
            <span className="detail-label">Created</span>
            <span title={task.created_at}>{timeAgo(task.created_at)}</span>
          </div>
          {task.last_addressed && (
            <div className="detail-meta-item">
              <span className="detail-label">Last Active</span>
              <span title={task.last_addressed}>{timeAgo(task.last_addressed)}</span>
            </div>
          )}
        </div>

        {task.summary && (
          <div className="detail-section">
            <span className="detail-label">Summary</span>
            <p>{task.summary}</p>
          </div>
        )}

        {task.paused_reason && (
          <div className="detail-section paused-section">
            <span className="detail-label">Paused Reason</span>
            <p>{task.paused_reason}</p>
          </div>
        )}

        {meta.last_step && (
          <div className="detail-section">
            <span className="detail-label">Progress</span>
            <div className="progress-info">
              {meta.last_step && <div><strong>Last step:</strong> {meta.last_step}</div>}
              {meta.next_step && <div><strong>Next step:</strong> {meta.next_step}</div>}
              {meta.files_changed && (
                <div>
                  <strong>Files changed:</strong>
                  <ul>
                    {meta.files_changed.map((f: string, i: number) => (
                      <li key={i}><code>{f}</code></li>
                    ))}
                  </ul>
                </div>
              )}
              {meta.commits && (
                <div>
                  <strong>Commits:</strong> {meta.commits.length}
                </div>
              )}
              {meta.notes && <div><strong>Notes:</strong> {meta.notes}</div>}
            </div>
          </div>
        )}

        {!meta.last_step && Object.keys(meta).length > 0 && (
          <div className="detail-section">
            <span className="detail-label">Metadata</span>
            <pre className="detail-json">{JSON.stringify(meta, null, 2)}</pre>
          </div>
        )}

        <div className="detail-actions">
          {onUnpause && task.status === 'paused' && (
            <button className="btn-unpause" onClick={() => onUnpause(key)}>
              Unpause Task
            </button>
          )}
          {onPause && isActive && (
            <button className="btn-pause" onClick={() => onPause(key)}>
              Pause Task
            </button>
          )}
          {onUnarchive && (
            <button className="btn-unarchive" onClick={() => onUnarchive(key)}>
              Restore Task
            </button>
          )}
          {onDelete && task.status !== 'archived' && (
            <button className="btn-delete" onClick={() => onDelete(key)}>
              Archive Task
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
