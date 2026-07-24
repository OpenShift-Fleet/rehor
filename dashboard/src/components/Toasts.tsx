import { useEffect, useRef, useState, useCallback } from 'react';
import { useWS } from '../hooks/useWebSocket';
import { timeAgo } from '../utils';
import {
  Alert,
  AlertGroup,
  AlertActionCloseButton,
  AlertVariant
} from '@patternfly/react-core';

interface Toast {
  id: number;
  label: string;
  detail: string;
  message: string;
  variant: 'success' | 'warning' | 'danger' | 'info' | 'custom';
  timestamp: number;
}

const eventConfig: Record<string, { label: string; variant: 'success' | 'warning' | 'danger' | 'info' | 'custom' }> = {
  task_added: { label: 'Task added', variant: 'success' },
  task_updated: { label: 'Task updated', variant: 'warning' },
  task_removed: { label: 'Task removed', variant: 'danger' },
  task_archived: { label: 'Task archived', variant: 'info' },
  memory_stored: { label: 'Memory stored', variant: 'custom' },
  memory_deleted: { label: 'Memory deleted', variant: 'danger' },
};

let toastIdCounter = 0;

export default function Toasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const { onEvent } = useWS();
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const removeToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  useEffect(() => {
    const unsub = onEvent((event) => {
      const config = eventConfig[event.type];
      if (!config) return;

      const data = event.data || {};
      const detail =
        data.external_key || data.title || (data.id ? `#${data.id}` : '');
      const message =
        data.summary || data.status || data.category || '';

      const id = ++toastIdCounter;
      const toast: Toast = {
        id,
        label: config.label,
        detail,
        message,
        variant: config.variant,
        timestamp: event.timestamp,
      };

      setToasts((prev) => [toast, ...prev].slice(0, 10));

      const timer = setTimeout(() => removeToast(id), 8000);
      timersRef.current.set(id, timer);
    });

    return () => {
      unsub();
      timersRef.current.forEach((timer) => clearTimeout(timer));
      timersRef.current.clear();
    };
  }, [onEvent, removeToast]);

  if (toasts.length === 0) return null;

  return (
    <AlertGroup isToast isLiveRegion>
      {toasts.map((toast) => (
        <Alert
          key={toast.id}
          variant={toast.variant as AlertVariant}
          title={`${toast.label}${toast.detail ? ` — ${toast.detail}` : ''}`}
          actionClose={<AlertActionCloseButton onClose={() => removeToast(toast.id)} />}
          timeout={8000}
          onTimeout={() => removeToast(toast.id)}
        >
          {toast.message && <p>{toast.message}</p>}
          <p style={{ fontSize: '12px', color: 'var(--pf-t--global--text--color--subtle)' }}>
            {timeAgo(new Date(toast.timestamp).toISOString())}
          </p>
        </Alert>
      ))}
    </AlertGroup>
  );
}
