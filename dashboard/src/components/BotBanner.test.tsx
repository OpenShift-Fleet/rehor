import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import BotBanner from './BotBanner';
import { makeBotStatus } from '../test/helpers';

vi.mock('../api', () => ({
  wakeInstance: vi.fn(),
}));

vi.mock('../hooks/useWebSocket', () => ({
  useWS: () => ({ connected: true, lastEvent: null, onEvent: () => () => {} }),
}));

import { wakeInstance } from '../api';

const mockWakeInstance = vi.mocked(wakeInstance);

beforeEach(() => {
  vi.clearAllMocks();
  mockWakeInstance.mockResolvedValue({ ok: true });
});

describe('BotBanner', () => {
  it('renders idle state badge and message', () => {
    const status = makeBotStatus({ state: 'idle', message: 'Waiting for tasks' });
    render(<BotBanner status={status} />);
    expect(screen.getByText('IDLE')).toBeInTheDocument();
    expect(screen.getByText('Waiting for tasks')).toBeInTheDocument();
  });

  it('renders working state with task info', () => {
    const status = makeBotStatus({
      state: 'working',
      message: 'Working on RHCLOUD-100',
      external_key: 'RHCLOUD-100',
      source_type: 'jira',
      repo: 'org/repo',
      cycle_start: new Date(Date.now() - 125_000).toISOString(),
    });
    render(<BotBanner status={status} />);
    expect(screen.getByText('WORKING')).toBeInTheDocument();
    expect(screen.getByText('Working on RHCLOUD-100')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'RHCLOUD-100' })).toBeInTheDocument();
    expect(screen.getByText('org/repo')).toBeInTheDocument();
  });

  it('renders error state', () => {
    const status = makeBotStatus({ state: 'error', message: 'Cycle failed' });
    render(<BotBanner status={status} />);
    expect(screen.getByText('ERROR')).toBeInTheDocument();
    expect(screen.getByText('Cycle failed')).toBeInTheDocument();
  });

  it('shows elapsed time when working with cycle_start', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-07-01T12:02:05Z'));
    const status = makeBotStatus({
      state: 'working',
      cycle_start: '2025-07-01T12:00:00Z',
      message: 'Working',
    });
    render(<BotBanner status={status} />);
    expect(screen.getByText('2m 5s')).toBeInTheDocument();
    vi.useRealTimers();
  });

  it('shows wake button when idle with instance_id', async () => {
    const user = userEvent.setup();
    const status = makeBotStatus({ state: 'idle', instance_id: 'dev-bot' });
    const { container } = render(<BotBanner status={status} />);
    const wakeBtn = container.querySelector('.wake-btn')!;
    await user.click(wakeBtn);
    expect(mockWakeInstance).toHaveBeenCalledWith('dev-bot');
  });

  it('does not show wake button when working', () => {
    const status = makeBotStatus({ state: 'working', instance_id: 'dev-bot' });
    render(<BotBanner status={status} />);
    expect(screen.queryByTitle('Wake bot — start next cycle immediately')).toBeNull();
  });

  it('toggles expanded class on banner toggle click', async () => {
    const user = userEvent.setup();
    const status = makeBotStatus();
    const { container } = render(<BotBanner status={status} />);
    expect(container.querySelector('.bot-banner.expanded')).toBeNull();
    await user.click(screen.getByTitle('Expand'));
    expect(container.querySelector('.bot-banner.expanded')).not.toBeNull();
    await user.click(screen.getByTitle('Collapse'));
    expect(container.querySelector('.bot-banner.expanded')).toBeNull();
  });
});
