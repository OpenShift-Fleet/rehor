import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import Instances from './Instances';
import { makeBotInstance } from '../test/helpers';

vi.mock('../api', () => ({
  fetchInstances: vi.fn(),
  wakeInstance: vi.fn(),
}));

vi.mock('../hooks/useWebSocket', () => ({
  useWS: () => ({ connected: true, lastEvent: null, onEvent: () => () => {} }),
}));

import { fetchInstances, wakeInstance } from '../api';

const mockFetchInstances = vi.mocked(fetchInstances);
const mockWakeInstance = vi.mocked(wakeInstance);

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchInstances.mockResolvedValue([]);
  mockWakeInstance.mockResolvedValue({ ok: true });
});

function renderInstances() {
  return render(
    <MemoryRouter>
      <Instances />
    </MemoryRouter>,
  );
}

describe('Instances page', () => {
  it('shows empty state when no instances', async () => {
    renderInstances();
    expect(await screen.findByText('No bot instances found')).toBeInTheDocument();
  });

  it('renders instance cards with state badges', async () => {
    const inst = makeBotInstance({
      instance_id: 'prod-bot',
      state: 'working',
      message: 'Working on task',
      active_tasks: 3,
      max_tasks: 10,
    });
    mockFetchInstances.mockResolvedValue([inst]);
    renderInstances();
    expect(await screen.findByText('prod-bot')).toBeInTheDocument();
    expect(screen.getByText('WORKING')).toBeInTheDocument();
    expect(screen.getByText('Working on task')).toBeInTheDocument();
    expect(screen.getByText('3/10 tasks')).toBeInTheDocument();
  });

  it('renders idle instance with wake button', async () => {
    const inst = makeBotInstance({ instance_id: 'idle-bot', state: 'idle' });
    mockFetchInstances.mockResolvedValue([inst]);
    renderInstances();
    expect(await screen.findByTitle('Wake bot — start next cycle immediately')).toBeInTheDocument();
  });

  it('calls wakeInstance when wake button clicked', async () => {
    const user = userEvent.setup();
    const inst = makeBotInstance({ instance_id: 'idle-bot', state: 'idle' });
    mockFetchInstances.mockResolvedValue([inst]);
    renderInstances();
    const wakeBtn = await screen.findByTitle('Wake bot — start next cycle immediately');
    await user.click(wakeBtn);
    expect(mockWakeInstance).toHaveBeenCalledWith('idle-bot');
  });

  it('renders external key link for jira instance', async () => {
    const inst = makeBotInstance({
      instance_id: 'jira-bot',
      state: 'working',
      external_key: 'RHCLOUD-500',
      source_type: 'jira',
      repo: 'org/repo',
    });
    mockFetchInstances.mockResolvedValue([inst]);
    renderInstances();
    const link = await screen.findByRole('link', { name: 'RHCLOUD-500' });
    expect(link).toHaveAttribute('href', 'https://redhat.atlassian.net/browse/RHCLOUD-500');
    expect(screen.getByText('org/repo')).toBeInTheDocument();
  });

  it('renders error state badge', async () => {
    const inst = makeBotInstance({ instance_id: 'err-bot', state: 'error', message: 'Failed' });
    mockFetchInstances.mockResolvedValue([inst]);
    renderInstances();
    expect(await screen.findByText('ERROR')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
  });
});
