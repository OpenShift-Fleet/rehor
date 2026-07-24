import type { Task, Memory } from '../types';
import { timeAgo, sourceUrl, displayKey } from '../utils';
import {
  Card,
  CardHeader,
  CardTitle,
  CardBody,
  CardFooter,
  Button,
  Label,
  LabelGroup,
  Flex,
  FlexItem,
  Content,
  DescriptionList,
  DescriptionListGroup,
  DescriptionListTerm,
  DescriptionListDescription,
  Divider,
  CodeBlock,
  CodeBlockCode
} from '@patternfly/react-core';
import { TimesIcon } from '@patternfly/react-icons';

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

const categoryColors: Record<string, 'green' | 'orange' | 'blue' | 'grey'> = {
  learning: 'green',
  review_feedback: 'orange',
  codebase_pattern: 'blue',
};

const statusColors: Record<string, 'blue' | 'green' | 'orange' | 'red' | 'purple' | 'grey'> = {
  in_progress: 'blue',
  pr_open: 'green',
  pr_changes: 'orange',
  done: 'grey',
  paused: 'purple',
  archived: 'grey',
};

const statusLabels: Record<string, string> = {
  in_progress: 'In Progress',
  pr_open: 'PR Open',
  pr_changes: 'Changes Requested',
  done: 'Done',
  paused: 'Paused',
  archived: 'Archived',
};

export default function DetailPanel(props: Props) {
  if (props.type === 'memory') {
    return <MemoryDetail {...props} />;
  }
  return <TaskDetail {...props} />;
}

function MemoryDetail({ memory, onClose, onDelete }: Omit<MemoryDetailProps, 'type'>) {
  const badgeColor = categoryColors[memory.category] || 'green';
  const prUrl = memory.metadata?.pr_url;

  return (
    <Card isGlass>
      <CardHeader
        actions={{ actions: <Button variant="plain" onClick={onClose}><TimesIcon /></Button> }}
      >
        <CardTitle>{memory.title}</CardTitle>
      </CardHeader>
      <CardBody>
        <CodeBlock>
          <CodeBlockCode>{memory.content}</CodeBlockCode>
        </CodeBlock>

        <Divider style={{ margin: '16px 0' }} />

        <DescriptionList isHorizontal isCompact>
          <DescriptionListGroup>
            <DescriptionListTerm>Category</DescriptionListTerm>
            <DescriptionListDescription>
              <Label color={badgeColor}>{memory.category.replace(/_/g, ' ')}</Label>
            </DescriptionListDescription>
          </DescriptionListGroup>
          {memory.repo && (
            <DescriptionListGroup>
              <DescriptionListTerm>Repo</DescriptionListTerm>
              <DescriptionListDescription>{memory.repo}</DescriptionListDescription>
            </DescriptionListGroup>
          )}
          {displayKey(memory) && (
            <DescriptionListGroup>
              <DescriptionListTerm>Source</DescriptionListTerm>
              <DescriptionListDescription>
                <a href={sourceUrl(memory) || '#'} target="_blank" rel="noopener noreferrer">
                  {displayKey(memory)}
                </a>
              </DescriptionListDescription>
            </DescriptionListGroup>
          )}
          {prUrl && (
            <DescriptionListGroup>
              <DescriptionListTerm>PR</DescriptionListTerm>
              <DescriptionListDescription>
                <a href={prUrl} target="_blank" rel="noopener noreferrer">{prUrl}</a>
              </DescriptionListDescription>
            </DescriptionListGroup>
          )}
          {memory.similarity != null && (
            <DescriptionListGroup>
              <DescriptionListTerm>Similarity</DescriptionListTerm>
              <DescriptionListDescription>
                <Label color="blue">{(memory.similarity * 100).toFixed(1)}%</Label>
              </DescriptionListDescription>
            </DescriptionListGroup>
          )}
          <DescriptionListGroup>
            <DescriptionListTerm>Created</DescriptionListTerm>
            <DescriptionListDescription title={memory.created_at}>
              {timeAgo(memory.created_at)}
            </DescriptionListDescription>
          </DescriptionListGroup>
          <DescriptionListGroup>
            <DescriptionListTerm>ID</DescriptionListTerm>
            <DescriptionListDescription>{memory.id}</DescriptionListDescription>
          </DescriptionListGroup>
        </DescriptionList>

        {memory.tags.length > 0 && (
          <>
            <Divider style={{ margin: '16px 0' }} />
            <LabelGroup categoryName="Tags">
              {memory.tags.map((t) => (
                <Label key={t} variant="outline">{t}</Label>
              ))}
            </LabelGroup>
          </>
        )}
      </CardBody>
      <CardFooter>
        <Button variant="danger" onClick={() => onDelete(memory.id)}>
          Delete Memory
        </Button>
      </CardFooter>
    </Card>
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

  return (
    <Card isGlass>
      <CardHeader
        actions={{ actions: <Button variant="plain" onClick={onClose}><TimesIcon /></Button> }}
      >
        <CardTitle>
          <Flex alignItems={{ default: 'alignItemsCenter' }} gap={{ default: 'gapSm' }}>
            <FlexItem>
              {url ? (
                <a href={url} target="_blank" rel="noopener noreferrer">{key}</a>
              ) : (
                <span>{key}</span>
              )}
            </FlexItem>
            {task.title && (
              <FlexItem>
                <span> &mdash; {task.title}</span>
              </FlexItem>
            )}
          </Flex>
        </CardTitle>
      </CardHeader>
      <CardBody>
        <DescriptionList isHorizontal isCompact>
          <DescriptionListGroup>
            <DescriptionListTerm>Status</DescriptionListTerm>
            <DescriptionListDescription>
              <Label color={statusColors[task.status] || 'grey'}>
                {statusLabels[task.status] || task.status}
              </Label>
            </DescriptionListDescription>
          </DescriptionListGroup>
          <DescriptionListGroup>
            <DescriptionListTerm>Repo(s)</DescriptionListTerm>
            <DescriptionListDescription>{repos.join(', ')}</DescriptionListDescription>
          </DescriptionListGroup>
          <DescriptionListGroup>
            <DescriptionListTerm>Branch</DescriptionListTerm>
            <DescriptionListDescription><code>{task.branch}</code></DescriptionListDescription>
          </DescriptionListGroup>

          {artifacts.length > 0 && (
            <DescriptionListGroup>
              <DescriptionListTerm>Artifacts</DescriptionListTerm>
              <DescriptionListDescription>
                {artifacts.map((a, i) => (
                  <div key={i}>
                    <a href={a.url} target="_blank" rel="noopener noreferrer">{a.name}</a>
                    {a.type && <span> ({a.type})</span>}
                  </div>
                ))}
              </DescriptionListDescription>
            </DescriptionListGroup>
          )}

          {!artifacts.length && prs.length > 0 && (
            <DescriptionListGroup>
              <DescriptionListTerm>PRs</DescriptionListTerm>
              <DescriptionListDescription>
                {prs.map((pr, i) => (
                  <div key={i}>
                    <a href={pr.url} target="_blank" rel="noopener noreferrer">
                      {pr.repo} #{pr.number}
                    </a>
                  </div>
                ))}
              </DescriptionListDescription>
            </DescriptionListGroup>
          )}

          <DescriptionListGroup>
            <DescriptionListTerm>Created</DescriptionListTerm>
            <DescriptionListDescription title={task.created_at}>
              {timeAgo(task.created_at)}
            </DescriptionListDescription>
          </DescriptionListGroup>
          {task.last_addressed && (
            <DescriptionListGroup>
              <DescriptionListTerm>Last Active</DescriptionListTerm>
              <DescriptionListDescription title={task.last_addressed}>
                {timeAgo(task.last_addressed)}
              </DescriptionListDescription>
            </DescriptionListGroup>
          )}
        </DescriptionList>

        {task.summary && (
          <>
            <Divider style={{ margin: '16px 0' }} />
            <Content component="h4">Summary</Content>
            <Content component="p">{task.summary}</Content>
          </>
        )}

        {task.paused_reason && (
          <>
            <Divider style={{ margin: '16px 0' }} />
            <Content component="h4">Paused Reason</Content>
            <Content component="p">{task.paused_reason}</Content>
          </>
        )}

        {meta.last_step && (
          <>
            <Divider style={{ margin: '16px 0' }} />
            <Content component="h4">Progress</Content>
            <DescriptionList isCompact>
              {meta.last_step && (
                <DescriptionListGroup>
                  <DescriptionListTerm>Last step</DescriptionListTerm>
                  <DescriptionListDescription>{meta.last_step}</DescriptionListDescription>
                </DescriptionListGroup>
              )}
              {meta.next_step && (
                <DescriptionListGroup>
                  <DescriptionListTerm>Next step</DescriptionListTerm>
                  <DescriptionListDescription>{meta.next_step}</DescriptionListDescription>
                </DescriptionListGroup>
              )}
              {meta.files_changed && (
                <DescriptionListGroup>
                  <DescriptionListTerm>Files changed</DescriptionListTerm>
                  <DescriptionListDescription>
                    {meta.files_changed.map((f: string, i: number) => (
                      <div key={i}><code>{f}</code></div>
                    ))}
                  </DescriptionListDescription>
                </DescriptionListGroup>
              )}
              {meta.commits && (
                <DescriptionListGroup>
                  <DescriptionListTerm>Commits</DescriptionListTerm>
                  <DescriptionListDescription>{meta.commits.length}</DescriptionListDescription>
                </DescriptionListGroup>
              )}
              {meta.notes && (
                <DescriptionListGroup>
                  <DescriptionListTerm>Notes</DescriptionListTerm>
                  <DescriptionListDescription>{meta.notes}</DescriptionListDescription>
                </DescriptionListGroup>
              )}
            </DescriptionList>
          </>
        )}

        {!meta.last_step && Object.keys(meta).length > 0 && (
          <>
            <Divider style={{ margin: '16px 0' }} />
            <Content component="h4">Metadata</Content>
            <CodeBlock>
              <CodeBlockCode>{JSON.stringify(meta, null, 2)}</CodeBlockCode>
            </CodeBlock>
          </>
        )}
      </CardBody>
      <CardFooter>
        <Flex gap={{ default: 'gapSm' }}>
          {onUnpause && task.status === 'paused' && (
            <FlexItem>
              <Button variant="primary" onClick={() => onUnpause(key)}>
                Unpause Task
              </Button>
            </FlexItem>
          )}
          {onPause && isActive && (
            <FlexItem>
              <Button variant="secondary" onClick={() => onPause(key)}>
                Pause Task
              </Button>
            </FlexItem>
          )}
          {onUnarchive && (
            <FlexItem>
              <Button variant="secondary" onClick={() => onUnarchive(key)}>
                Restore Task
              </Button>
            </FlexItem>
          )}
          {onDelete && task.status !== 'archived' && (
            <FlexItem>
              <Button variant="danger" onClick={() => onDelete(key)}>
                Archive Task
              </Button>
            </FlexItem>
          )}
        </Flex>
      </CardFooter>
    </Card>
  );
}
