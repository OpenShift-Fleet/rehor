import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import CycleRuns from './CycleRuns';
import { makeCycleRun, makeTaskCycleGroup } from '../test/helpers';

vi.mock('../api', () => ({
  fetchCycleRuns: vi.fn(),
  fetchCycleRunsByTask: vi.fn(),
  fetchCycleRunTranscript: vi.fn(),
}));

vi.mock('../hooks/useWebSocket', () => ({
  useWS: () => ({ connected: true, lastEvent: null, onEvent: () => () => {} }),
}));

import { fetchCycleRuns, fetchCycleRunsByTask } from '../api';

const mockFetchCycleRunsByTask = vi.mocked(fetchCycleRunsByTask);
const mockFetchCycleRuns = vi.mocked(fetchCycleRuns);

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchCycleRunsByTask.mockResolvedValue([]);
  mockFetchCycleRuns.mockResolvedValue({ items: [], total: 0 });
});

function renderCycleRuns(instanceId?: string) {
  return render(
    <MemoryRouter>
      <CycleRuns instanceId={instanceId} />
    </MemoryRouter>,
  );
}

describe('CycleRuns page', () => {
  it('shows empty state when no groups', async () => {
    renderCycleRuns();
    expect(await screen.findByText('No cycle runs found')).toBeInTheDocument();
  });

  it('renders task groups from API', async () => {
    const group = makeTaskCycleGroup({ external_key: 'RHCLOUD-100', title: 'Fix login', cycle_count: 5 });
    mockFetchCycleRunsByTask.mockResolvedValue([group]);
    renderCycleRuns();
    expect(await screen.findByText('RHCLOUD-100')).toBeInTheDocument();
    expect(screen.getByText('Fix login')).toBeInTheDocument();
    expect(screen.getByText('5 cycles')).toBeInTheDocument();
  });

  it('passes instance_id to fetchCycleRunsByTask', async () => {
    renderCycleRuns('prod-bot');
    await screen.findByText('No cycle runs found');
    expect(mockFetchCycleRunsByTask).toHaveBeenCalledWith({ instance_id: 'prod-bot' });
  });

  it('expands group and loads cycle runs on click', async () => {
    const user = userEvent.setup();
    const group = makeTaskCycleGroup({ task_id: 42, external_key: 'RHCLOUD-200' });
    const run = makeCycleRun({ id: 10, task_id: 42, cycle_type: 'task_work' });
    mockFetchCycleRunsByTask.mockResolvedValue([group]);
    mockFetchCycleRuns.mockResolvedValue({ items: [run], total: 1 });

    renderCycleRuns();
    await screen.findByText('RHCLOUD-200');
    await user.click(screen.getByText('Fix login bug'));

    expect(mockFetchCycleRuns).toHaveBeenCalledWith({
      task_id: 42,
      limit: 50,
    });
    expect(await screen.findByText('#10')).toBeInTheDocument();
    expect(screen.getByText('Work')).toBeInTheDocument();
  });

  it('collapses group on second click', async () => {
    const user = userEvent.setup();
    const group = makeTaskCycleGroup({ task_id: 42, external_key: 'RHCLOUD-300' });
    const run = makeCycleRun({ id: 11, task_id: 42 });
    mockFetchCycleRunsByTask.mockResolvedValue([group]);
    mockFetchCycleRuns.mockResolvedValue({ items: [run], total: 1 });

    renderCycleRuns();
    await screen.findByText('RHCLOUD-300');
    await user.click(screen.getByText('Fix login bug'));
    expect(await screen.findByText('#11')).toBeInTheDocument();
    await user.click(screen.getByText('Fix login bug'));
    expect(screen.queryByText('#11')).toBeNull();
  });

  it('shows detail panel when cycle run selected', async () => {
    const user = userEvent.setup();
    const group = makeTaskCycleGroup({ task_id: 55, external_key: 'RHCLOUD-400' });
    const run = makeCycleRun({ id: 20, task_id: 55, cycle_type: 'triage_only' });
    mockFetchCycleRunsByTask.mockResolvedValue([group]);
    mockFetchCycleRuns.mockResolvedValue({ items: [run], total: 1 });

    renderCycleRuns();
    await screen.findByText('RHCLOUD-400');
    await user.click(screen.getByText('Fix login bug'));
    await screen.findByText('#20');
    await user.click(screen.getByText('#20').closest('.cycle-run-card')!);

    expect(screen.getByText('Cycle #20')).toBeInTheDocument();
    expect(screen.getByText('triage only')).toBeInTheDocument();
  });

  it('renders orphan cycles group label', async () => {
    const group = makeTaskCycleGroup({
      task_id: null,
      external_key: null,
      title: null,
      cycle_count: 2,
    });
    mockFetchCycleRunsByTask.mockResolvedValue([group]);
    renderCycleRuns();
    expect(await screen.findByText('Orphan cycles')).toBeInTheDocument();
    expect(screen.getByText('2 cycles')).toBeInTheDocument();
  });
});
