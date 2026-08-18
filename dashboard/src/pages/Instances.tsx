import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import type { BotInstance } from '../types';
import { fetchInstances } from '../api';
import { useWS } from '../hooks/useWebSocket';
import { timeAgo, sourceUrl, displayKey, effectiveState, stateLabelColor, stateIconStatus } from '../utils';
import {
  Card,
  CardHeader,
  CardTitle,
  CardBody,
  CardFooter,
  LabelGroup,
  Label,
  Flex,
  FlexItem,
  Content,
  Divider,
  Icon
} from '@patternfly/react-core';
import { CircleIcon } from '@patternfly/react-icons';

export default function Instances() {
  const [instances, setInstances] = useState<BotInstance[]>([]);
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

  useEffect(() => {
    return onEvent((event) => {
      if (event.type === 'bot_status') {
        const id = event.data.instance_id;
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
        {instances.map((inst) => {
          const state = effectiveState(inst);
          return (
          <div key={inst.instance_id}>
            <Card isCompact isGlass style={{ cursor: 'pointer' }} onClick={() => navigate(`/instances/${encodeURIComponent(inst.instance_id)}/tasks`)}>
            <CardHeader
              actions={{ actions: <Label color={stateLabelColor(state)}>{state.toUpperCase()}</Label> }}
            >
              <CardTitle>
                <Flex alignItems={{ default: 'alignItemsFlexStart' }} gap={{ default: 'gapSm' }} flexWrap={{ default: 'nowrap' }} style={{ minWidth: 0 }}>
                  <FlexItem style={{ flexShrink: 0 }}>
                    <Icon status={stateIconStatus(state)}>
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
                <Content component="p" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--pf-t--global--text--color--subtle)' }}>
                  {state === 'sleep' ? "Bot hasn't checked in recently" : inst.message}
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
                  <Content>
                    <small title={inst.updated_at}>{timeAgo(inst.updated_at)}</small>
                  </Content>
                </Flex>
              </Flex>
            </CardFooter>
          </Card>
          </div>
          );
        })}
      </div>
    </div>
  );
}
