import { test, expect } from '../../e2e/fixtures';

const defaultGroup = {
  task_id: 42,
  external_key: 'RHCLOUD-100',
  title: 'Fix login bug',
  cycle_count: 5,
  latest_started_at: '2026-07-01T10:00:00Z',
  total_cost_usd: 2.5,
};

const defaultRun = {
  id: 10,
  task_id: 42,
  cycle_type: 'task_work',
  started_at: '2026-07-01T10:00:00Z',
  finished_at: '2026-07-01T10:05:00Z',
  tool_calls: 5,
  tokens_used: 2000,
  cost_usd: 0.5,
  has_transcript: false,
  instance_id: 'dev-bot',
  progress: null,
};

test.describe('CycleRuns page', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/cycle-runs/by-task*', (route) => {
      route.fulfill({ json: [] });
    });
    await page.route('**/api/cycle-runs?*', (route) => {
      route.fulfill({ json: { items: [], total: 0 } });
    });
  });

  test('shows empty state when no groups', async ({ mount, page }) => {
    await mount('CycleRuns/Default');
    await expect(page.getByText('No cycle runs found')).toBeVisible();
  });

  test('renders task groups from API', async ({ mount, page }) => {
    const group = { ...defaultGroup, external_key: 'RHCLOUD-100', title: 'Fix login', cycle_count: 5 };
    await page.route('**/api/cycle-runs/by-task*', (route) => {
      route.fulfill({ json: [group] });
    });

    await mount('CycleRuns/Default');
    await expect(page.getByText('RHCLOUD-100')).toBeVisible();
    await expect(page.getByText('Fix login')).toBeVisible();
    await expect(page.getByText('5 cycles')).toBeVisible();
  });

  test('passes instance_id to fetchCycleRunsByTask', async ({ mount, page }) => {
    let requestUrl = '';
    await page.route('**/api/cycle-runs/by-task*', (route) => {
      requestUrl = route.request().url();
      route.fulfill({ json: [] });
    });

    await mount('CycleRuns/WithInstanceId');
    await page.waitForTimeout(200);

    expect(requestUrl).toContain('instance_id=prod-bot');
  });

  test('expands group and loads cycle runs on click', async ({ mount, page }) => {
    await page.route('**/api/cycle-runs/by-task*', (route) => {
      route.fulfill({ json: [defaultGroup] });
    });
    await page.route('**/api/cycle-runs?*', (route) => {
      route.fulfill({ json: { items: [defaultRun], total: 1 } });
    });

    await mount('CycleRuns/Default');
    await page.getByText('Fix login bug').click();

    await expect(page.getByText('#10')).toBeVisible();
    await expect(page.getByText('Work')).toBeVisible();
  });

  test('renders orphan cycles group label', async ({ mount, page }) => {
    const orphanGroup = { ...defaultGroup, task_id: null, external_key: null, title: null, cycle_count: 2 };
    await page.route('**/api/cycle-runs/by-task*', (route) => {
      route.fulfill({ json: [orphanGroup] });
    });

    await mount('CycleRuns/Default');
    await expect(page.getByText('Orphan cycles')).toBeVisible();
    await expect(page.getByText('2 cycles')).toBeVisible();
  });
});
