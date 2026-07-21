import { useEffect, useRef, useState, useCallback } from 'react';
import { useWS } from '../hooks/useWebSocket';
import { timeAgo } from '../utils';

interface Toast {
  id: number;
  icon: string;
  label: string;
  detail: string;
  message: string;
  border: string;
  timestamp: number;
}

const eventConfig: Record<string, { icon: string; label: string; border: string }> = {
  task_added: { icon: '+', label: 'Task added', border: 'var(--green)' },
  task_updated: { icon: '~', label: 'Task updated', border: 'var(--yellow)' },
  task_removed: { icon: '-', label: 'Task removed', border: 'var(--red)' },
  task_archived: { icon: '-', label: 'Task archived', border: 'var(--red)' },
  memory_stored: { icon: '+', label: 'Memory stored', border: 'var(--purple)' },
  memory_deleted: { icon: '-', label: 'Memory deleted', border: 'var(--red)' },
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
      if (!config) return; // skip bot_status and unknown events

      const data = event.data || {};
      const detail =
        data.external_key || data.title || (data.id ? `#${data.id}` : '');
      const message =
        data.summary || data.status || data.category || '';

      const id = ++toastIdCounter;
      const toast: Toast = {
        id,
        icon: config.icon,
        label: config.label,
        detail,
        message,
        border: config.border,
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
    <div className="toast-container">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className="toast"
          style={{ borderLeftColor: toast.border }}
        >
          <div className="toast-header">
            <span className="toast-icon">{toast.icon}</span>
            <span className="toast-label">{toast.label}</span>
            {toast.detail && (
              <span className="toast-detail">{toast.detail}</span>
            )}
            <button
              className="toast-close"
              onClick={() => removeToast(toast.id)}
            >
              X
            </button>
          </div>
          {toast.message && (
            <div className="toast-message">{toast.message}</div>
          )}
          <div className="toast-time">
            {timeAgo(new Date(toast.timestamp).toISOString())}
          </div>
        </div>
      ))}
    </div>
  );
}
