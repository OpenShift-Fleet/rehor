import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import type { BotInstance } from '../types';
import { fetchInstances } from '../api';
import { useWS } from '../hooks/useWebSocket';
import { timeAgo, sourceUrl, displayKey } from '../utils';

export default function Instances() {
  const [instances, setInstances] = useState<BotInstance[]>([]);
  const navigate = useNavigate();
  const { onEvent } = useWS();

  const load = useCallback(async () => {
    try {
      const data = await fetchInstances();
      setInstances(data);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    return onEvent((event) => {
      if (event.type === 'bot_status') {
        setInstances((prev) => {
          const id = event.data.instance_id;
          if (!id) return prev;
          const idx = prev.findIndex((i) => i.instance_id === id);
          if (idx >= 0) {
            const updated = [...prev];
            updated[idx] = { ...updated[idx], ...event.data };
            return updated;
          }
          return [...prev, { ...event.data, active_tasks: 0, max_tasks: 10 }];
        });
      }
      if (event.type === 'task_added' || event.type === 'task_updated' || event.type === 'task_archived') {
        load();
      }
    });
  }, [onEvent, load]);

  return (
    <div>
      {instances.length === 0 && (
        <div className="empty-state">No bot instances found</div>
      )}
      <div className="instance-grid">
        {instances.map((inst) => (
          <div
            key={inst.instance_id}
            className={`instance-card state-${inst.state}`}
            onClick={() => navigate(`/instances/${encodeURIComponent(inst.instance_id)}/tasks`)}
          >
            <div className="instance-card-header">
              <div className="instance-name-row">
                <span className={`indicator-dot ${inst.state}`}>
                  <span className="ping-ring" />
                </span>
                <span className="instance-name">{inst.instance_id}</span>
              </div>
              <span className={`state-badge ${inst.state}`}>
                {inst.state.toUpperCase()}
              </span>
            </div>

            <div className="instance-message" key={inst.message}>
              {inst.message}
            </div>

            <div className="instance-card-meta">
              {displayKey(inst) && (
                <a
                  href={sourceUrl(inst) || '#'}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="banner-jira"
                  onClick={(e) => e.stopPropagation()}
                >
                  {displayKey(inst)}
                </a>
              )}
              {inst.repo && <span className="banner-repo">{inst.repo}</span>}
            </div>

            <div className="instance-card-footer">
              <span className="instance-tasks">
                {inst.active_tasks}/{inst.max_tasks} tasks
              </span>
              <span className="instance-updated" title={inst.updated_at}>
                {timeAgo(inst.updated_at)}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
