import { useEffect, useState, useCallback } from 'react';
import type { Task } from '../types';
import { fetchTasks, deleteTask, pauseTask, unpauseTask } from '../api';
import { useWS } from '../hooks/useWebSocket';
import TaskCard from '../components/TaskCard';
import DetailPanel from '../components/DetailPanel';
import Pagination from '../components/Pagination';
import {
  MenuToggle,
  MenuToggleElement,
  Select,
  SelectList,
  SelectOption
} from '@patternfly/react-core';
import ConfirmDialog from '../components/ConfirmDialog';

const STATUS_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'pr_open', label: 'PR Open' },
  { value: 'pr_changes', label: 'PR Changes' },
  { value: 'paused', label: 'Paused' },
  { value: 'done', label: 'Done' },
];

const LIMIT = 20;

type DialogState =
  | { action: 'pause'; key: string }
  | { action: 'unpause'; key: string }
  | { action: 'archive'; key: string }
  | null;

export default function Tasks({ instanceId }: { instanceId?: string }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<Task | null>(null);
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [error, setError] = useState<string | null>(null);

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

  const runAction = async (action: () => Promise<Response>) => {
    const res = await action();
    if (!res.ok) {
      let msg = `Request failed (${res.status})`;
      try {
        const body = await res.json();
        if (body?.error) msg = body.error;
      } catch { /* ignore non-JSON */ }
      setError(msg);
      return false;
    }
    return true;
  };

  const handleDialogConfirm = async (inputValue?: string) => {
    if (!dialog) return;
    let ok = false;
    switch (dialog.action) {
      case 'pause':
        ok = await runAction(() => pauseTask(dialog.key, inputValue?.trim() || undefined));
        break;
      case 'unpause':
        ok = await runAction(() => unpauseTask(dialog.key));
        break;
      case 'archive':
        ok = await runAction(() => deleteTask(dialog.key));
        break;
    }
    setDialog(null);
    if (ok) {
      setSelected(null);
      load();
    }
  };

  const dialogProps = () => {
    if (!dialog) return { title: '', message: '' };
    switch (dialog.action) {
      case 'pause':
        return {
          title: 'Pause task',
          message: `Pause ${dialog.key}? The bot will skip it until unpaused.`,
          confirmLabel: 'Pause',
          inputLabel: 'Reason (optional)',
          inputPlaceholder: 'e.g. Waiting for design review',
        };
      case 'unpause':
        return {
          title: 'Unpause task',
          message: `Unpause ${dialog.key}? The bot may pick it up again.`,
          confirmLabel: 'Unpause',
        };
      case 'archive':
        return {
          title: 'Archive task',
          message: `Archive ${dialog.key}? The bot will stop tracking it.`,
          confirmLabel: 'Archive',
          variant: 'danger' as const,
        };
    }
  };

  const currentLabel = STATUS_OPTIONS.find((o) => o.value === status)?.label || 'All';

  return (
    <div className="split-layout">
      <div className="split-main">
        <div className="controls">
          <Select
            isOpen={isFilterOpen}
            selected={status}
            onSelect={(_e, val) => { setStatus(val as string); setOffset(0); setIsFilterOpen(false); }}
            onOpenChange={setIsFilterOpen}
            toggle={(toggleRef: React.Ref<MenuToggleElement>) => (
              <MenuToggle ref={toggleRef} onClick={() => setIsFilterOpen(!isFilterOpen)} isExpanded={isFilterOpen}>
                {currentLabel}
              </MenuToggle>
            )}
          >
            <SelectList>
              {STATUS_OPTIONS.map((o) => (
                <SelectOption key={o.value} value={o.value}>{o.label}</SelectOption>
              ))}
            </SelectList>
          </Select>
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
            onDelete={(key) => setDialog({ action: 'archive', key })}
            onPause={(key) => setDialog({ action: 'pause', key })}
            onUnpause={(key) => setDialog({ action: 'unpause', key })}
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
        message={error || ''}
        confirmLabel="OK"
        onConfirm={() => setError(null)}
        onCancel={() => setError(null)}
      />
    </div>
  );
}
