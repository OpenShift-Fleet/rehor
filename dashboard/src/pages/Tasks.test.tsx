import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Tasks from './Tasks';
import { makeTask } from '../test/helpers';

vi.mock('../api', () => ({
  fetchTasks: vi.fn(),
  deleteTask: vi.fn(),
  pauseTask: vi.fn(),
  unpauseTask: vi.fn(),
}));

vi.mock('../hooks/useWebSocket', () => ({
  useWS: () => ({ connected: true, lastEvent: null, onEvent: () => () => {} }),
}));

import { fetchTasks, deleteTask, pauseTask, unpauseTask } from '../api';

const mockFetchTasks = vi.mocked(fetchTasks);
const mockPauseTask = vi.mocked(pauseTask);
const mockUnpauseTask = vi.mocked(unpauseTask);
const mockDeleteTask = vi.mocked(deleteTask);

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchTasks.mockResolvedValue({ items: [], total: 0 });
});

function okResponse() {
  return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
}

function errorResponse(status: number, body: Record<string, string>) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}

async function selectTask(taskName: string) {
  const user = userEvent.setup();
  const card = screen.getByText(taskName).closest('.pf-v6-c-card');
  await user.click(card!);
}

describe('Tasks page — dialog flows', () => {
  it('pause: opens dialog, submits reason, calls pauseTask', async () => {
    const user = userEvent.setup();
    const task = makeTask({ status: 'in_progress', external_key: 'RHCLOUD-100', title: 'Fix bug' });
    mockFetchTasks.mockResolvedValue({ items: [task], total: 1 });
    mockPauseTask.mockReturnValue(okResponse());

    render(<Tasks />);
    await screen.findByText('RHCLOUD-100');
    await selectTask('RHCLOUD-100');

    await user.click(screen.getByText('Pause Task'));
    expect(screen.getByText('Pause task')).toBeInTheDocument();

    const input = screen.getByPlaceholderText('e.g. Waiting for design review');
    await user.type(input, 'blocked on UX');
    await user.click(screen.getByText('Pause'));

    expect(mockPauseTask).toHaveBeenCalledWith('RHCLOUD-100', 'blocked on UX');
  });

  it('unpause: opens dialog and calls unpauseTask', async () => {
    const user = userEvent.setup();
    const task = makeTask({ status: 'paused', external_key: 'RHCLOUD-200', paused_reason: 'waiting' });
    mockFetchTasks.mockResolvedValue({ items: [task], total: 1 });
    mockUnpauseTask.mockReturnValue(okResponse());

    render(<Tasks />);
    await screen.findByText('RHCLOUD-200');
    await selectTask('RHCLOUD-200');

    await user.click(screen.getByText('Unpause Task'));
    await user.click(screen.getByText('Unpause'));

    expect(mockUnpauseTask).toHaveBeenCalledWith('RHCLOUD-200');
  });

  it('archive: opens danger dialog and calls deleteTask', async () => {
    const user = userEvent.setup();
    const task = makeTask({ status: 'in_progress', external_key: 'RHCLOUD-300' });
    mockFetchTasks.mockResolvedValue({ items: [task], total: 1 });
    mockDeleteTask.mockReturnValue(okResponse());

    render(<Tasks />);
    await screen.findByText('RHCLOUD-300');
    await selectTask('RHCLOUD-300');

    await user.click(screen.getByText('Archive Task'));
    const archiveBtn = screen.getByText('Archive').closest('button');
    expect(archiveBtn).toHaveClass('pf-m-danger');
    await user.click(archiveBtn!);

    expect(mockDeleteTask).toHaveBeenCalledWith('RHCLOUD-300');
  });

  it('shows error dialog when API returns an error', async () => {
    const user = userEvent.setup();
    const task = makeTask({ status: 'paused', external_key: 'RHCLOUD-400' });
    mockFetchTasks.mockResolvedValue({ items: [task], total: 1 });
    mockUnpauseTask.mockReturnValue(errorResponse(404, { error: 'Task RHCLOUD-400 not found or not paused' }));

    render(<Tasks />);
    await screen.findByText('RHCLOUD-400');
    await selectTask('RHCLOUD-400');

    await user.click(screen.getByText('Unpause Task'));
    await user.click(screen.getByText('Unpause'));

    expect(await screen.findByText('Task RHCLOUD-400 not found or not paused')).toBeInTheDocument();
  });
});
