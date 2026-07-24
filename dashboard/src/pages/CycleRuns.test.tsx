import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import CycleRuns from './CycleRuns';

vi.mock('../api', () => ({
  fetchCycleRunsByTask: vi.fn(),
  fetchCycleRuns: vi.fn(),
  fetchCycleRunTranscript: vi.fn(),
}));

vi.mock('../hooks/useWebSocket', () => ({
  useWS: () => ({ connected: true, lastEvent: null, onEvent: () => () => {} }),
}));

import { fetchCycleRunsByTask, fetchCycleRuns } from '../api';

const mockFetchCycleRunsByTask = vi.mocked(fetchCycleRunsByTask);
const mockFetchCycleRuns = vi.mocked(fetchCycleRuns);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CycleRuns page', () => {
  it('handles empty cycle runs response correctly', async () => {
    // Mock API returns paginated response with items array
    mockFetchCycleRunsByTask.mockResolvedValue({
      items: [],
      total: 0,
      limit: 20,
      offset: 0,
    });

    render(
      <MemoryRouter initialEntries={['/instances/dev-bot/cycles']}>
        <Routes>
          <Route path="/instances/:instanceId/cycles" element={<CycleRuns />} />
        </Routes>
      </MemoryRouter>
    );

    // Should render empty state without crashing
    await waitFor(() => {
      expect(screen.getByText('No cycle runs found')).toBeInTheDocument();
    });
  });

  it('handles cycle runs with task groups', async () => {
    const mockGroups = [
      {
        task_id: 1,
        external_key: 'RHCLOUD-001',
        summary: 'Fix login bug',
        cycle_count: 3,
        last_cycle_start: '2026-07-24T10:00:00Z',
      },
      {
        task_id: 2,
        external_key: 'RHCLOUD-002',
        summary: 'Add dark mode',
        cycle_count: 1,
        last_cycle_start: '2026-07-24T09:00:00Z',
      },
    ];

    mockFetchCycleRunsByTask.mockResolvedValue({
      items: mockGroups,
      total: 2,
      limit: 20,
      offset: 0,
    });

    mockFetchCycleRuns.mockResolvedValue({
      items: [],
      total: 0,
      limit: 20,
      offset: 0,
    });

    render(
      <MemoryRouter initialEntries={['/instances/dev-bot/cycles']}>
        <Routes>
          <Route path="/instances/:instanceId/cycles" element={<CycleRuns />} />
        </Routes>
      </MemoryRouter>
    );

    // Should render both task groups
    await waitFor(() => {
      expect(screen.getByText('RHCLOUD-001')).toBeInTheDocument();
      expect(screen.getByText('RHCLOUD-002')).toBeInTheDocument();
    });
  });
});
