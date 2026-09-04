import { useEffect, useState } from 'react';
import type { BotStatus } from '../types';
import { timeAgo, sourceUrl, displayKey, effectiveState, stateLabelColor, stateIconStatus, stateBorderColor } from '../utils';
import {
  Card,
  CardBody,
  Flex,
  FlexItem,
  Label,
  Icon
} from '@patternfly/react-core';
import { CircleIcon } from '@patternfly/react-icons';

interface Props {
  status: BotStatus;
}

export default function BotBanner({ status }: Props) {
  const [elapsed, setElapsed] = useState('');
  const state = effectiveState(status);

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

  const message = state === 'sleep' ? "Bot hasn't checked in recently" : status.message;

  return (
    <Card isCompact isGlass style={{ borderLeft: `3px solid ${stateBorderColor(state)}`, marginBottom: '12px' }}>
      <CardBody>
      <Flex alignItems={{ default: 'alignItemsCenter' }} justifyContent={{ default: 'justifyContentSpaceBetween' }} flexWrap={{ default: 'nowrap' }}>
        <Flex alignItems={{ default: 'alignItemsCenter' }} gap={{ default: 'gapSm' }} flexWrap={{ default: 'nowrap' }} style={{ flex: 1, minWidth: 0 }}>
          <FlexItem>
            <Icon status={stateIconStatus(state)}>
              <CircleIcon />
            </Icon>
          </FlexItem>
          <FlexItem>
            <Label color={stateLabelColor(state)}>
              {state.toUpperCase()}
            </Label>
          </FlexItem>
          <FlexItem style={{ minWidth: 0, flex: 1 }}>
            <span style={{ color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'block' }}>{message}</span>
          </FlexItem>
        </Flex>
        <Flex alignItems={{ default: 'alignItemsCenter' }} gap={{ default: 'gapSm' }} flexWrap={{ default: 'nowrap' }} style={{ flexShrink: 0 }}>
          {displayKey(status) && (
            <FlexItem>
              <Label color="blue" href={sourceUrl(status) || '#'}>
                {displayKey(status)}
              </Label>
            </FlexItem>
          )}
          {status.repo && (
            <FlexItem>
              <Label variant="outline" style={{ maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{status.repo}</Label>
            </FlexItem>
          )}
          {status.instance_id && (
            <FlexItem>
              <Label variant="outline" style={{ maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{status.instance_id}</Label>
            </FlexItem>
          )}
          {elapsed && (
            <FlexItem>
              <Label variant="outline">{elapsed}</Label>
            </FlexItem>
          )}
          <FlexItem>
            <span style={{ color: 'var(--text-dim)', fontSize: '12px' }} title={status.updated_at}>
              {timeAgo(status.updated_at)}
            </span>
          </FlexItem>
        </Flex>
      </Flex>
      </CardBody>
    </Card>
  );
}
