import type { CycleRun } from '../types';
import { timeAgo, formatDuration, formatTokens, sourceUrl } from '../utils';
import { fetchCycleRunTranscript } from '../api';

interface Props {
  run: CycleRun;
  selected?: boolean;
  onClick?: () => void;
}

const typeLabels: Record<string, string> = {
  task_work: 'Work',
  triage_only: 'Triage',
  idle: 'Idle',
  error: 'Error',
};

export default function CycleRunCard({ run, selected, onClick }: Props) {
  const progress = run.progress || {};
  const duration =
    run.started_at && run.finished_at
      ? new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()
      : null;
  const extKey = progress.external_key as string | undefined;
  const extUrl = sourceUrl({ external_key: extKey, source_type: progress.source_type as string });

  const handleDownload = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const text = await fetchCycleRunTranscript(run.id);
      const ts = run.started_at.replace(/[:.]/g, '-').slice(0, 19);
      const blob = new Blob([text], { type: 'application/x-ndjson' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `cycle-${run.id}-${run.cycle_type}-${ts}.jsonl`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // no transcript available
    }
  };

  return (
    <div
      className={`cycle-run-card cycle-type-${run.cycle_type}${selected ? ' selected' : ''}`}
      onClick={onClick}
    >
      <div className="cycle-run-header">
        <span className={`cycle-type-badge ${run.cycle_type}`}>
          {typeLabels[run.cycle_type] || run.cycle_type}
        </span>
        <span className="cycle-run-id">#{run.id}</span>
        <span className="cycle-run-time" title={run.started_at}>
          {timeAgo(run.started_at)}
        </span>
        {run.has_transcript && (
          <button
            className="btn-download-cycle"
            onClick={handleDownload}
            title="Download transcript"
          >
            &#11015;
          </button>
        )}
      </div>
      <div className="cycle-run-meta">
        {duration != null && (
          <span className="cycle-run-duration">{formatDuration(duration)}</span>
        )}
        {run.tool_calls != null && (
          <span className="cycle-run-tools">{run.tool_calls} tools</span>
        )}
        {run.tokens_used != null && (
          <span className="cycle-run-tokens">{formatTokens(run.tokens_used)} tokens</span>
        )}
      </div>
      {extKey && (
        <a
          href={extUrl || '#'}
          target="_blank"
          rel="noopener noreferrer"
          className="cycle-run-jira"
          onClick={(e) => e.stopPropagation()}
        >
          {extKey}
        </a>
      )}
      {progress.summary && (
        <div className="cycle-run-summary">{String(progress.summary).slice(0, 120)}</div>
      )}
      {progress.last_step && (
        <div className="cycle-run-step">Step: {progress.last_step}</div>
      )}
      {run.instance_id && (
        <span className="cycle-run-instance">{run.instance_id}</span>
      )}
    </div>
  );
}
