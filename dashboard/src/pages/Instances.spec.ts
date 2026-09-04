import { test, expect } from '../../e2e/fixtures';

function makeInstance(overrides: Record<string, any> = {}) {
  return {
    instance_id: 'dev-bot',
    state: 'idle',
    message: '',
    external_key: null,
    source_type: null,
    source_url: null,
    repo: null,
    cycle_start: null,
    updated_at: '2026-07-01T10:00:00Z',
    active_tasks: 2,
    max_tasks: 10,
    ...overrides,
  };
}

test.describe('Instances page', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/instances', (route) => {
      route.fulfill({ json: [] });
    });
  });

  test('shows empty state when no instances', async ({ mount, page }) => {
    await mount('Instances/Default');
    await expect(page.getByText('No bot instances found')).toBeVisible();
  });

  test('renders instance cards with state badges', async ({ mount, page }) => {
    const inst = makeInstance({ instance_id: 'prod-bot', state: 'working', message: 'Working on task', active_tasks: 3 });
    await page.route('**/api/instances', (route) => {
      route.fulfill({ json: [inst] });
    });

    await mount('Instances/Default');
    await expect(page.getByText('prod-bot')).toBeVisible();
    await expect(page.getByText('WORKING', { exact: true })).toBeVisible();
    await expect(page.getByText('Working on task')).toBeVisible();
    await expect(page.getByText('3/10 tasks')).toBeVisible();
  });

  test('renders external key link for jira instance', async ({ mount, page }) => {
    const inst = makeInstance({
      instance_id: 'jira-bot',
      state: 'working',
      external_key: 'RHCLOUD-500',
      source_type: 'jira',
      repo: 'org/repo',
    });
    await page.route('**/api/instances', (route) => {
      route.fulfill({ json: [inst] });
    });

    await mount('Instances/Default');
    const link = page.getByRole('link', { name: 'RHCLOUD-500' });
    await expect(link).toHaveAttribute('href', 'https://redhat.atlassian.net/browse/RHCLOUD-500');
    await expect(page.getByText('org/repo')).toBeVisible();
  });

  test('renders sleep state for instance with stale updated_at', async ({ mount, page }) => {
    const inst = makeInstance({ instance_id: 'sleep-bot', state: 'idle', updated_at: '2020-01-01T00:00:00Z' });
    await page.route('**/api/instances', (route) => {
      route.fulfill({ json: [inst] });
    });

    await mount('Instances/Default');
    await expect(page.getByText('SLEEP', { exact: true })).toBeVisible();
    await expect(page.getByText("Bot hasn't checked in recently")).toBeVisible();
  });

  test('does not show sleep for working instance even with stale updated_at', async ({ mount, page }) => {
    const inst = makeInstance({ instance_id: 'busy-bot', state: 'working', message: 'On it', updated_at: '2020-01-01T00:00:00Z' });
    await page.route('**/api/instances', (route) => {
      route.fulfill({ json: [inst] });
    });

    await mount('Instances/Default');
    await expect(page.getByText('WORKING', { exact: true })).toBeVisible();
    await expect(page.getByText('On it')).toBeVisible();
  });

  test('renders error state badge', async ({ mount, page }) => {
    const inst = makeInstance({ instance_id: 'err-bot', state: 'error', message: 'Failed' });
    await page.route('**/api/instances', (route) => {
      route.fulfill({ json: [inst] });
    });

    await mount('Instances/Default');
    await expect(page.getByText('ERROR')).toBeVisible();
    await expect(page.getByText('Failed')).toBeVisible();
  });
});
