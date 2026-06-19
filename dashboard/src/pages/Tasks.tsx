import { useEffect, useState, useCallback } from 'react';
import type { Task } from '../types';
import { fetchTasks, deleteTask } from '../api';
import { useWS } from '../hooks/useWebSocket';
import TaskCard from '../components/TaskCard';
import DetailPanel from '../components/DetailPanel';
import Pagination from '../components/Pagination';

const STATUS_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'pr_open', label: 'PR Open' },
  { value: 'pr_changes', label: 'PR Changes' },
  { value: 'paused', label: 'Paused' },
  { value: 'done', label: 'Done' },
];

const LIMIT = 20;

export default function Tasks({ instanceId }: { instanceId?: string }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<Task | null>(null);

  const { onEvent } = useWS();

  const load = useCallback(async () => {
    const res = await fetchTasks({
      status: status || undefined,
      exclude_status: status ? undefined : 'archived',
      limit: LIMIT,
      offset,
      instance_id: instanceId,
    });
    setTasks(res.items || []);
    setTotal(res.total || 0);
  }, [status, offset, instanceId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    return onEvent((event) => {
      if (event.type === 'task_added' || event.type === 'task_updated' || event.type === 'task_archived') {
        load();
      }
    });
  }, [onEvent, load]);

  const handleDelete = async (key: string) => {
    await deleteTask(key);
    setSelected(null);
    load();
  };

  return (
    <div className="split-layout">
      <div className="split-main">
        <div className="controls">
          <select value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }}>
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div className="card-grid">
          {tasks.length === 0 && <div className="empty-state">No tasks found</div>}
          {tasks.map((t) => (
            <TaskCard
              key={t.id}
              task={t}
              selected={selected?.id === t.id}
              onClick={() => setSelected(t)}
            />
          ))}
        </div>
        <Pagination total={total} limit={LIMIT} offset={offset} onChange={setOffset} />
      </div>
      {selected && (
        <div className="split-detail">
          <DetailPanel
            type="task"
            task={selected}
            onClose={() => setSelected(null)}
            onDelete={handleDelete}
          />
        </div>
      )}
    </div>
  );
}
