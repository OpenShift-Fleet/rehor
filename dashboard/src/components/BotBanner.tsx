import { useEffect, useState, useCallback } from 'react';
import type { BotStatus } from '../types';
import { wakeInstance } from '../api';
import { useWS } from '../hooks/useWebSocket';
import { timeAgo, sourceUrl, displayKey } from '../utils';
import {
  Card,
  CardBody,
  Flex,
  FlexItem,
  Label,
  Button,
  Icon
} from '@patternfly/react-core';
import { CircleIcon } from '@patternfly/react-icons';

interface Props {
  status: BotStatus;
}

export default function BotBanner({ status }: Props) {
  const [elapsed, setElapsed] = useState('');
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

  const borderColor = status.state === 'working' ? 'var(--yellow)' : status.state === 'error' ? 'var(--red)' : 'var(--green)';

  return (
    <Card isCompact isGlass style={{ borderLeft: `3px solid ${borderColor}`, marginBottom: '12px' }}>
      <CardBody>
      <Flex alignItems={{ default: 'alignItemsCenter' }} justifyContent={{ default: 'justifyContentSpaceBetween' }} flexWrap={{ default: 'nowrap' }}>
        <Flex alignItems={{ default: 'alignItemsCenter' }} gap={{ default: 'gapSm' }} flexWrap={{ default: 'nowrap' }} style={{ flex: 1, minWidth: 0 }}>
          <FlexItem>
            <Icon status={status.state === 'working' ? 'warning' : status.state === 'error' ? 'danger' : 'success'}>
              <CircleIcon />
            </Icon>
          </FlexItem>
          <FlexItem>
            <Label color={status.state === 'working' ? 'orange' : status.state === 'error' ? 'red' : 'green'}>
              {status.state.toUpperCase()}
            </Label>
          </FlexItem>
          <FlexItem style={{ minWidth: 0, flex: 1 }}>
            <span style={{ color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'block' }}>{status.message}</span>
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
          {status.state === 'idle' && status.instance_id && (
            <FlexItem>
              <Button
                variant="plain"
                size="sm"
                isDisabled={waking}
                onClick={handleWake}
                title="Wake bot \u2014 start next cycle immediately"
              >
                {waking ? 'Waking\u2026' : '\u25B6'}
              </Button>
            </FlexItem>
          )}
        </Flex>
      </Flex>
      </CardBody>
    </Card>
  );
}
