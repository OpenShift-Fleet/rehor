import { test, expect } from '../../e2e/fixtures';

const defaultAnalytics = {
  summary: {
    total_cycles: 10, work_cycles: 7, idle_cycles: 3, error_cycles: 0,
    unique_tickets: 5, total_cost: 12.5, avg_cost_per_work_cycle: 1.79,
    avg_turns: 8, avg_duration_ms: 300000, repos_touched: 2, tickets_resolved: 5,
  },
  work_types: [
    { category: 'new_ticket', cycles: 4, total_cost: 7.0, avg_cost: 1.75, avg_turns: 10, avg_duration_ms: 400000 },
    { category: 'pr_review', cycles: 2, total_cost: 3.0, avg_cost: 1.5, avg_turns: 6, avg_duration_ms: 200000 },
    { category: 'follow_up', cycles: 1, total_cost: 2.5, avg_cost: 2.5, avg_turns: 5, avg_duration_ms: 150000 },
  ],
  repos: [
    { repo: 'frontend', tickets: 3, cycles: 5, total_cost: 8.0, avg_turns: 9 },
    { repo: 'backend', tickets: 2, cycles: 5, total_cost: 4.5, avg_turns: 7 },
  ],
  tickets: [
    { external_key: 'RHCLOUD-001', title: 'Fix login', status: 'done', repo: 'frontend', total_cycles: 2, impl_cycles: 1, review_cycles: 1, total_cost: 3.5, hours_span: 4 },
  ],
  feedback: { avg_review_rounds: 1.2, zero_review: 3, one_review: 5, multi_review: 2 },
};

const defaultCycleEntry = {
  id: 1,
  timestamp: '2026-07-01T10:00:00Z',
  label: 'cycle-1',
  session_id: 'sess-1',
  external_key: 'RHCLOUD-001',
  source_type: 'jira',
  cost_usd: 0.5,
  num_turns: 5,
  duration_ms: 120000,
  input_tokens: 5000,
  output_tokens: 2000,
  cache_read_tokens: 300,
  cache_write_tokens: 100,
  model: 'claude-sonnet-4-20250514',
  is_error: false,
  no_work: false,
  work_type: 'new_ticket',
  repo: 'frontend',
  summary: null,
};

test.describe('Costs page', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/costs?*', (route) => {
      route.fulfill({ json: { items: [], daily: [] } });
    });
    await page.route('**/api/analytics?*', (route) => {
      route.fulfill({ json: defaultAnalytics });
    });
  });

  test('renders summary cards from analytics', async ({ mount, page }) => {
    await mount('Costs/Default');
    await expect(page.getByText('Tickets Resolved')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('5 unique worked on')).toBeVisible();
    await expect(page.getByText('Total Cost')).toBeVisible();
    await expect(page.getByText('$12.50', { exact: true })).toBeVisible();
  });

  test('renders cycle list with mock data', async ({ mount, page }) => {
    const cycle = { ...defaultCycleEntry, id: 2, external_key: 'RHCLOUD-100', cost_usd: 1.25, num_turns: 7, duration_ms: 180000, output_tokens: 3000, cache_read_tokens: 500 };
    await page.route('**/api/costs?*', (route) => {
      route.fulfill({ json: { items: [cycle], daily: [] } });
    });

    await mount('Costs/Default');
    await expect(page.getByText('RHCLOUD-100')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('$1.25')).toBeVisible();
    await expect(page.getByText('7 turns')).toBeVisible();
    await expect(page.locator('.cycle-row').getByText('New Ticket')).toBeVisible();
  });

  test('shows empty cycles message when no data', async ({ mount, page }) => {
    await mount('Costs/Default');
    await expect(page.getByText('No cycles recorded')).toBeVisible({ timeout: 10000 });
  });
});
