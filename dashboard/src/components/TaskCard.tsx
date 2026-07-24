import type { Task } from '../types';
import { timeAgo, sourceUrl, displayKey } from '../utils';
import {
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Flex,
  FlexItem,
  Label,
  LabelGroup,
  Content,
  Icon
} from '@patternfly/react-core';
import { ExclamationTriangleIcon } from '@patternfly/react-icons';

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

const statusColors: Record<string, 'blue' | 'green' | 'orange' | 'red' | 'purple' | 'grey'> = {
  in_progress: 'blue',
  pr_open: 'green',
  pr_changes: 'orange',
  done: 'grey',
  paused: 'purple',
  archived: 'grey',
};

export default function TaskCard({ task, selected, onClick }: Props) {
  const url = sourceUrl(task);
  const key = displayKey(task);
  const firstArtifact = task.artifacts?.[0];

  return (
    <Card
      isCompact
      isGlass
      isSelected={selected}
      onClick={onClick}
      style={{ cursor: 'pointer', borderLeft: `3px solid ${task.status === 'in_progress' ? 'var(--accent)' : task.status === 'pr_changes' ? 'var(--yellow)' : task.status === 'pr_open' ? 'var(--green)' : task.status === 'paused' ? 'var(--purple)' : 'transparent'}` }}
    >
      <CardHeader
        actions={{ actions: <Label color={statusColors[task.status] || 'grey'}>{statusLabels[task.status] || task.status}</Label> }}
      >
        <CardTitle>
          {url ? (
            <a href={url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} style={{ fontWeight: 600 }}>
              {key}
            </a>
          ) : (
            <span style={{ fontWeight: 600 }}>{key}</span>
          )}
        </CardTitle>
      </CardHeader>
      <CardBody>
        <Flex direction={{ default: 'column' }} gap={{ default: 'gapSm' }}>
          {task.title && (
            <FlexItem>
              <Content component="p" style={{ margin: 0 }}>{task.title}</Content>
            </FlexItem>
          )}
          <FlexItem>
            <LabelGroup>
              <Label variant="outline">{task.repo}</Label>
              {firstArtifact && (
                <span onClick={(e) => e.stopPropagation()}>
                  <Label color="blue" href={firstArtifact.url}>
                    {firstArtifact.name}
                  </Label>
                </span>
              )}
              <Label variant="outline">{timeAgo(task.created_at)}</Label>
              {task.last_addressed && (
                <Label variant="outline">active {timeAgo(task.last_addressed)}</Label>
              )}
            </LabelGroup>
          </FlexItem>
          {task.instance_id && (
            <FlexItem>
              <Label variant="outline" color="grey">{task.instance_id}</Label>
            </FlexItem>
          )}
          {task.paused_reason && (
            <FlexItem>
              <Content component="p" style={{ margin: 0, color: 'var(--yellow)', fontSize: '13px' }}>
                <Icon status="warning" size="sm"><ExclamationTriangleIcon /></Icon>{' '}
                {task.paused_reason}
              </Content>
            </FlexItem>
          )}
          {task.slack_notification && (
            <FlexItem>
              <Label variant="outline" icon={<span>🔔</span>}>
                {task.slack_notification.event_type.replace(/_/g, ' ')} · {timeAgo(task.slack_notification.sent_at)}
              </Label>
            </FlexItem>
          )}
        </Flex>
      </CardBody>
    </Card>
  );
}
