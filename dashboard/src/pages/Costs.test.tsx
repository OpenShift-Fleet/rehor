import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import Costs from './Costs';

vi.mock('../api', () => ({
  fetchCosts: vi.fn(),
  fetchAnalytics: vi.fn(),
}));

vi.mock('../hooks/useWebSocket', () => ({
  useWS: () => ({ connected: true, lastEvent: null, onEvent: () => () => {} }),
}));

import { fetchCosts, fetchAnalytics } from '../api';

const mockFetchCosts = vi.mocked(fetchCosts);
const mockFetchAnalytics = vi.mocked(fetchAnalytics);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Costs page', () => {
  it('handles malformed analytics response', async () => {
    // Mock API returns costs but analytics is missing fields
    mockFetchCosts.mockResolvedValue({
      items: [],
      daily: [],
      total: 0,
      limit: 200,
      offset: 0,
    });

    // Analytics response missing all fields except summary
    mockFetchAnalytics.mockResolvedValue({
      // Missing summary, work_types, repos, tickets, feedback
    });

    render(
      <MemoryRouter>
        <Costs />
      </MemoryRouter>
    );

    // Should render without crashing even with incomplete data
    await waitFor(() => {
      expect(screen.getByText(/Tickets Resolved/i)).toBeInTheDocument();
    });
  });

  it('handles empty costs response correctly', async () => {
    // Mock API returns paginated response with items array
    mockFetchCosts.mockResolvedValue({
      items: [],
      daily: [],
      total: 0,
      limit: 200,
      offset: 0,
    });

    mockFetchAnalytics.mockResolvedValue({
      summary: {
        total_cycles: 0,
        work_cycles: 0,
        idle_cycles: 0,
        error_cycles: 0,
        unique_tickets: 0,
        total_cost: 0,
        avg_cost_per_work_cycle: 0,
        avg_turns: 0,
        avg_duration_ms: 0,
        repos_touched: 0,
        tickets_resolved: 0,
      },
      work_types: [],
      repos: [],
      tickets: [],
      feedback: [],
    });

    render(
      <MemoryRouter>
        <Costs />
      </MemoryRouter>
    );

    // Should render without crashing
    await waitFor(() => {
      expect(screen.getByText(/Tickets Resolved/i)).toBeInTheDocument();
    });
  });

  it('handles costs with data', async () => {
    const mockCycles = [
      {
        id: 1,
        cycle_number: 1,
        external_key: 'RHCLOUD-001',
        repo: 'test-repo',
        work_type: 'bug_fix',
        model: 'claude-opus-4',
        input_tokens: 1000,
        output_tokens: 500,
        cache_creation_tokens: 0,
        cache_read_tokens: 200,
        cost_usd: 0.05,
        duration_ms: 30000,
        started_at: '2026-07-24T10:00:00Z',
      },
    ];

    const mockDaily = [
      {
        day: '2026-07-24',
        cycles: 1,
        total_cost: 0.05,
        input_tokens: 1000,
        output_tokens: 500,
        cache_read: 200,
        cache_write: 0,
        total_duration: 30000,
        total_turns: 5,
        idle_cycles: 0,
        error_cycles: 0,
      },
    ];

    mockFetchCosts.mockResolvedValue({
      items: mockCycles,
      daily: mockDaily,
      total: 1,
      limit: 200,
      offset: 0,
    });

    mockFetchAnalytics.mockResolvedValue({
      summary: {
        total_cycles: 1,
        work_cycles: 1,
        idle_cycles: 0,
        error_cycles: 0,
        unique_tickets: 1,
        total_cost: 0.05,
        avg_cost_per_work_cycle: 0.05,
        avg_turns: 5,
        avg_duration_ms: 30000,
        repos_touched: 1,
        tickets_resolved: 1,
      },
      work_types: [{ category: 'other', cycles: 1, total_cost: 0.05, avg_cost: 0.05, avg_turns: 5, avg_duration_ms: 30000 }],
      repos: [{ repo: 'test-repo', cycles: 1, total_cost: 0.05 }],
      tickets: [{ external_key: 'RHCLOUD-001', cycles: 1, total_cost: 0.05 }],
      feedback: [],
    });

    render(
      <MemoryRouter>
        <Costs />
      </MemoryRouter>
    );

    // Should render cost data
    await waitFor(() => {
      expect(screen.getByText('RHCLOUD-001')).toBeInTheDocument();
    });
  });
});
