import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import type { BotInstance } from '../types';
import { fetchInstances, wakeInstance } from '../api';
import { useWS } from '../hooks/useWebSocket';
import { timeAgo, sourceUrl, displayKey } from '../utils';
import {
  Card,
  CardHeader,
  CardTitle,
  CardBody,
  CardExpandableContent,
  Level,
  LabelGroup,
  Label,
  LabelColor,
  Grid,
  Flex,
  FlexItem,
  Button,
  Dropdown,
  DropdownList,
  DropdownItem,
  MenuToggle,
  MenuToggleElement,
  CardFooter,
  Content,
  Divider,
  Icon
} from '@patternfly/react-core';
import { CircleIcon } from '@patternfly/react-icons';

export default function Instances() {
  const [instances, setInstances] = useState<BotInstance[]>([]);
  const [wakingIds, setWakingIds] = useState<Set<string>>(new Set());
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

  const handleWake = useCallback(async (e: React.MouseEvent, instanceId: string) => {
    e.stopPropagation();
    setWakingIds((prev) => new Set(prev).add(instanceId));
    try {
      await wakeInstance(instanceId);
    } catch {
      setWakingIds((prev) => {
        const next = new Set(prev);
        next.delete(instanceId);
        return next;
      });
    }
  }, []);

  useEffect(() => {
    return onEvent((event) => {
      if (event.type === 'bot_status') {
        const id = event.data.instance_id;
        if (id && event.data.state === 'working') {
          setWakingIds((prev) => {
            if (!prev.has(id)) return prev;
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        }
        setInstances((prev) => {
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
          <div>
            <Card isCompact isGlass key={inst.instance_id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/instances/${encodeURIComponent(inst.instance_id)}/tasks`)}>
            <CardHeader
              actions={{ actions: <Label color={inst.state === 'working' ? 'orange' : inst.state === 'error' ? 'red' : 'green'}>{inst.state.toUpperCase()}</Label> }}
            >
              <CardTitle>
                <Flex alignItems={{ default: 'alignItemsFlexStart' }} gap={{ default: 'gapSm' }} flexWrap={{ default: 'nowrap' }} style={{ minWidth: 0 }}>
                  <FlexItem style={{ flexShrink: 0 }}>
                    <Icon status={inst.state === 'working' ? 'warning' : inst.state === 'error' ? 'danger' : 'success'}>
                      <CircleIcon />
                    </Icon>
                  </FlexItem>
                  <FlexItem style={{ minWidth: 0, overflowWrap: 'break-word', wordBreak: 'break-word' }}>
                    {inst.instance_id.length > 65 ? `${inst.instance_id.slice(0, 65)}…` : inst.instance_id}
                  </FlexItem>
                </Flex>
              </CardTitle>
            </CardHeader>
            <CardBody>
              <Flex direction={{ default: 'column' }} gap={{ default: 'gapSm' }}>
                <Content component="p" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--pf-v6-global--Color--200)' }}>
                  {inst.message}
                </Content>
                <LabelGroup>
                  {displayKey(inst) && (
                    <Label
                      color="blue"
                      href={sourceUrl(inst) || '#'}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {displayKey(inst)}
                    </Label>
                  )}
                  {inst.repo && (
                    <Label color="grey" variant="outline">
                      {inst.repo}
                    </Label>
                  )}
                </LabelGroup>
              </Flex>
            </CardBody>
            <Divider />
            <CardFooter>
              <Flex justifyContent={{ default: 'justifyContentSpaceBetween' }} alignItems={{ default: 'alignItemsCenter' }}>
                <Label variant="outline">{inst.active_tasks}/{inst.max_tasks} tasks</Label>
                <Flex alignItems={{ default: 'alignItemsCenter' }} gap={{ default: 'gapSm' }}>
                  {inst.state === 'idle' && (
                    <Button
                      variant="plain"
                      size="sm"
                      isDisabled={wakingIds.has(inst.instance_id)}
                      onClick={(e) => handleWake(e as unknown as React.MouseEvent, inst.instance_id)}
                      title="Wake bot — start next cycle immediately"
                    >
                      {wakingIds.has(inst.instance_id) ? 'Waking…' : '▶'}
                    </Button>
                  )}
                  <Content>
                    <small title={inst.updated_at}>{timeAgo(inst.updated_at)}</small>
                  </Content>
                </Flex>
              </Flex>
            </CardFooter>
          </Card>
          </div>
        ))}
      </div>
    </div>
  );
}
