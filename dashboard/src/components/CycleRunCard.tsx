import type { CycleRun } from '../types';
import { timeAgo, formatDuration, formatTokens, sourceUrl } from '../utils';
import { fetchCycleRunTranscript } from '../api';
import {
  Card,
  CardHeader,
  CardTitle,
  CardBody,
  Flex,
  FlexItem,
  Label,
  LabelGroup,
  Button,
  Content
} from '@patternfly/react-core';
import { DownloadIcon } from '@patternfly/react-icons';

interface Props {
  run: CycleRun;
  selected?: boolean;
  onClick?: () => void;
}

const typeColors: Record<string, 'blue' | 'green' | 'orange' | 'grey' | 'red'> = {
  task_work: 'blue',
  triage_only: 'green',
  idle: 'grey',
  error: 'red',
};

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
    <Card
      isCompact
      isGlass
      isSelected={selected}
      onClick={onClick}
      style={{ cursor: 'pointer' }}
    >
      <CardHeader
        actions={{ actions: run.has_transcript ? (
          <Button variant="plain" size="sm" onClick={handleDownload} title="Download transcript">
            <DownloadIcon />
          </Button>
        ) : undefined }}
      >
        <CardTitle>
          <Flex alignItems={{ default: 'alignItemsCenter' }} gap={{ default: 'gapSm' }}>
            <FlexItem>
              <Label color={typeColors[run.cycle_type] || 'grey'}>
                {typeLabels[run.cycle_type] || run.cycle_type}
              </Label>
            </FlexItem>
            <FlexItem>
              <Content component="small" style={{ margin: 0 }}>#{run.id}</Content>
            </FlexItem>
            <FlexItem>
              <Content component="small" style={{ margin: 0 }} title={run.started_at}>
                {timeAgo(run.started_at)}
              </Content>
            </FlexItem>
          </Flex>
        </CardTitle>
      </CardHeader>
      <CardBody>
        <Flex direction={{ default: 'column' }} gap={{ default: 'gapSm' }}>
          <FlexItem>
            <LabelGroup>
              {duration != null && <Label variant="outline">{formatDuration(duration)}</Label>}
              {run.tool_calls != null && <Label variant="outline">{run.tool_calls} tools</Label>}
              {run.tokens_used != null && <Label variant="outline">{formatTokens(run.tokens_used)} tokens</Label>}
            </LabelGroup>
          </FlexItem>
          {extKey && (
            <FlexItem>
              <span onClick={(e) => e.stopPropagation()}>
                <Label color="blue" href={extUrl || '#'}>
                  {extKey}
                </Label>
              </span>
            </FlexItem>
          )}
          {progress.summary && (
            <FlexItem>
              <Content component="p" style={{ margin: 0, color: 'var(--pf-v6-global--Color--200)' }}>
                {String(progress.summary).slice(0, 120)}
              </Content>
            </FlexItem>
          )}
          {progress.last_step && (
            <FlexItem>
              <Content component="small" style={{ margin: 0 }}>Step: {progress.last_step}</Content>
            </FlexItem>
          )}
          {run.instance_id && (
            <FlexItem>
              <Label variant="outline" color="grey">{run.instance_id}</Label>
            </FlexItem>
          )}
        </Flex>
      </CardBody>
    </Card>
  );
}
