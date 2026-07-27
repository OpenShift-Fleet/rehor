import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Costs from './Costs';
import { makeCycleEntry, makeDailyAggregate, makeAnalyticsData } from '../test/helpers';

vi.mock('../api', () => ({
  fetchCosts: vi.fn(),
  fetchAnalytics: vi.fn(),
}));

vi.mock('../hooks/useWebSocket', () => ({
  useWS: () => ({ connected: true, lastEvent: null, onEvent: () => () => {} }),
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AreaChart: ({ children }: { children: React.ReactNode }) => <div data-testid="area-chart">{children}</div>,
  BarChart: ({ children }: { children: React.ReactNode }) => <div data-testid="bar-chart">{children}</div>,
  PieChart: ({ children }: { children: React.ReactNode }) => <div data-testid="pie-chart">{children}</div>,
  Area: () => null,
  Bar: () => null,
  Pie: () => null,
  Cell: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  Legend: () => null,
  CartesianGrid: () => null,
}));

import { fetchCosts, fetchAnalytics } from '../api';

const mockFetchCosts = vi.mocked(fetchCosts);
const mockFetchAnalytics = vi.mocked(fetchAnalytics);

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchCosts.mockResolvedValue({ items: [], daily: [] });
  mockFetchAnalytics.mockResolvedValue(makeAnalyticsData());
});

describe('Costs page', () => {
  it('shows loading state initially', () => {
    mockFetchCosts.mockReturnValue(new Promise(() => {}));
    mockFetchAnalytics.mockReturnValue(new Promise(() => {}));
    render(<Costs />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('renders summary cards from analytics', async () => {
    const analytics = makeAnalyticsData();
    render(<Costs />);
    expect(await screen.findByText('Tickets Resolved')).toBeInTheDocument();
    expect(screen.getByText(String(analytics.summary.tickets_resolved))).toBeInTheDocument();
    expect(screen.getByText('Total Cost')).toBeInTheDocument();
    expect(screen.getByText(`$${analytics.summary.total_cost.toFixed(2)}`)).toBeInTheDocument();
    expect(screen.getByText('Work Cycles')).toBeInTheDocument();
    expect(screen.getByText(String(analytics.summary.work_cycles))).toBeInTheDocument();
  });

  it('renders cycle list with mock data', async () => {
    const cycle = makeCycleEntry({
      external_key: 'RHCLOUD-100',
      cost_usd: 1.25,
      num_turns: 7,
      duration_ms: 180000,
      output_tokens: 3000,
      cache_read_tokens: 500,
      work_type: 'new_ticket',
    });
    mockFetchCosts.mockResolvedValue({
      items: [cycle],
      daily: [makeDailyAggregate()],
    });
    render(<Costs />);
    expect(await screen.findByText('RHCLOUD-100')).toBeInTheDocument();
    expect(screen.getByText('$1.25')).toBeInTheDocument();
    expect(screen.getByText('7 turns')).toBeInTheDocument();
    expect(screen.getByText('New Ticket')).toBeInTheDocument();
  });

  it('shows empty cycles message when no data', async () => {
    render(<Costs />);
    expect(await screen.findByText('No cycles recorded')).toBeInTheDocument();
  });

  it('renders daily summary section', async () => {
    mockFetchCosts.mockResolvedValue({
      items: [makeCycleEntry()],
      daily: [makeDailyAggregate({ day: '2025-07-15' })],
    });
    render(<Costs />);
    expect(await screen.findByText('Daily Summary')).toBeInTheDocument();
    expect(screen.getByText('Cost per Day')).toBeInTheDocument();
    expect(screen.getByText('Tokens per Day')).toBeInTheDocument();
  });

  it('switches to date range mode', async () => {
    const user = userEvent.setup();
    render(<Costs />);
    await screen.findByText('Tickets Resolved');
    await user.click(screen.getByText('Date Range'));
    expect(screen.getByText('From')).toBeInTheDocument();
    expect(screen.getByText('To')).toBeInTheDocument();
  });

  it('changes preset days and refetches', async () => {
    const user = userEvent.setup();
    render(<Costs />);
    await screen.findByText('Tickets Resolved');
    const select = screen.getByDisplayValue('30 days');
    await user.selectOptions(select, '7');
    expect(mockFetchCosts).toHaveBeenCalledWith(7, 500, undefined, undefined);
    expect(mockFetchAnalytics).toHaveBeenCalledWith(7, undefined, undefined);
  });

  it('switches metric tabs', async () => {
    const user = userEvent.setup();
    mockFetchCosts.mockResolvedValue({
      items: [makeCycleEntry(), makeCycleEntry({ id: 2 })],
      daily: [],
    });
    render(<Costs />);
    await screen.findByText('Tickets Resolved');
    await user.click(screen.getByText('Output Tokens'));
    expect(screen.getByText('Output Tokens').className).toContain('active');
  });
});
