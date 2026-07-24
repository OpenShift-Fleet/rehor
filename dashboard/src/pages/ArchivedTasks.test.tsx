import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ArchivedTasks from './ArchivedTasks';
import { makeTask } from '../test/helpers';

vi.mock('../api', () => ({
  fetchTasks: vi.fn(),
  unarchiveTask: vi.fn(),
}));

vi.mock('../hooks/useWebSocket', () => ({
  useWS: () => ({ connected: true, lastEvent: null, onEvent: () => () => {} }),
}));

import { fetchTasks, unarchiveTask } from '../api';

const mockFetchTasks = vi.mocked(fetchTasks);
const mockUnarchiveTask = vi.mocked(unarchiveTask);

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchTasks.mockResolvedValue({ items: [], total: 0 });
});

async function selectTask(taskName: string) {
  const user = userEvent.setup();
  const card = screen.getByText(taskName).closest('.pf-v6-c-card');
  await user.click(card!);
}

describe('ArchivedTasks page', () => {
  it('restore: opens dialog and calls unarchiveTask', async () => {
    const user = userEvent.setup();
    const task = makeTask({ status: 'archived', external_key: 'RHCLOUD-500' });
    mockFetchTasks.mockResolvedValue({ items: [task], total: 1 });
    mockUnarchiveTask.mockResolvedValue(new Response(JSON.stringify({ unarchived: true }), { status: 200 }));

    render(<ArchivedTasks />);
    await screen.findByText('RHCLOUD-500');
    await selectTask('RHCLOUD-500');

    await user.click(screen.getByText('Restore Task'));
    await user.click(screen.getByText('Restore'));

    expect(mockUnarchiveTask).toHaveBeenCalledWith('RHCLOUD-500');
  });

  it('shows error from JSON error response', async () => {
    const user = userEvent.setup();
    const task = makeTask({ status: 'archived', external_key: 'RHCLOUD-600' });
    mockFetchTasks.mockResolvedValue({ items: [task], total: 1 });
    mockUnarchiveTask.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Task RHCLOUD-600 not found or not archived' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    render(<ArchivedTasks />);
    await screen.findByText('RHCLOUD-600');
    await selectTask('RHCLOUD-600');

    await user.click(screen.getByText('Restore Task'));
    await user.click(screen.getByText('Restore'));

    expect(await screen.findByText('Task RHCLOUD-600 not found or not archived')).toBeInTheDocument();
  });

  it('shows fallback error for non-JSON response', async () => {
    const user = userEvent.setup();
    const task = makeTask({ status: 'archived', external_key: 'RHCLOUD-700' });
    mockFetchTasks.mockResolvedValue({ items: [task], total: 1 });
    mockUnarchiveTask.mockResolvedValue(new Response('Internal Server Error', { status: 500 }));

    render(<ArchivedTasks />);
    await screen.findByText('RHCLOUD-700');
    await selectTask('RHCLOUD-700');

    await user.click(screen.getByText('Restore Task'));
    await user.click(screen.getByText('Restore'));

    expect(await screen.findByText('Request failed (500)')).toBeInTheDocument();
  });
});
