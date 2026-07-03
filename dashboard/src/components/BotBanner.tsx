import { useEffect, useState, useCallback } from 'react';
import type { BotStatus } from '../types';
import { wakeInstance } from '../api';
import { useWS } from '../hooks/useWebSocket';
import { timeAgo, sourceUrl, displayKey } from '../utils';

interface Props {
  status: BotStatus;
}

export default function BotBanner({ status }: Props) {
  const [elapsed, setElapsed] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [waking, setWaking] = useState(false);
  const { onEvent } = useWS();

  const handleWake = useCallback(async () => {
    if (!status.instance_id) return;
    setWaking(true);
    try {
      await wakeInstance(status.instance_id);
    } catch {
      setWaking(false);
    }
  }, [status.instance_id]);

  useEffect(() => {
    return onEvent((event) => {
      if (
        event.type === 'bot_status' &&
        event.data.instance_id === status.instance_id &&
        event.data.state === 'working'
      ) {
        setWaking(false);
      }
    });
  }, [onEvent, status.instance_id]);

  useEffect(() => {
    if (status.state !== 'working' || !status.cycle_start) {
      setElapsed('');
      return;
    }

    const tick = () => {
      const ms = Date.now() - new Date(status.cycle_start!).getTime();
      const s = Math.floor(ms / 1000);
      const m = Math.floor(s / 60);
      const h = Math.floor(m / 60);
      if (h > 0) {
        setElapsed(`${h}h ${m % 60}m ${s % 60}s`);
      } else if (m > 0) {
        setElapsed(`${m}m ${s % 60}s`);
      } else {
        setElapsed(`${s}s`);
      }
    };

    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [status.state, status.cycle_start]);

  return (
    <div className={`bot-banner state-${status.state}${expanded ? ' expanded' : ''}`}>
      <div className="banner-left">
        <span className={`indicator-dot ${status.state}`}>
          <span className="ping-ring" />
        </span>
        <span className={`state-badge ${status.state}`}>
          {status.state.toUpperCase()}
        </span>
        <span className="banner-message" key={status.message}>
          {status.message}
        </span>
      </div>
      <div className="banner-meta">
        {displayKey(status) && (
          <a
            href={sourceUrl(status) || '#'}
            target="_blank"
            rel="noopener noreferrer"
            className="banner-jira"
          >
            {displayKey(status)}
          </a>
        )}
        {status.repo && <span className="banner-repo">{status.repo}</span>}
        {status.instance_id && <span className="banner-instance">{status.instance_id}</span>}
        {elapsed && <span className="banner-elapsed">{elapsed}</span>}
        <span className="banner-updated" title={status.updated_at}>
          {timeAgo(status.updated_at)}
        </span>
        {status.state === 'idle' && status.instance_id && (
          <button
            className={`wake-btn${waking ? ' waking' : ''}`}
            disabled={waking}
            onClick={handleWake}
            title="Wake bot \u2014 start next cycle immediately"
          >
            {waking ? (
              'Waking\u2026'
            ) : (
              <svg width="12" height="14" viewBox="0 0 12 14" fill="currentColor">
                <path d="M0 0 L12 7 L0 14 Z" />
              </svg>
            )}
          </button>
        )}
        <button
          className="banner-toggle"
          onClick={() => setExpanded(!expanded)}
          title={expanded ? 'Collapse' : 'Expand'}
        >
          {expanded ? '\u25B2' : '\u25BC'}
        </button>
      </div>
    </div>
  );
}
