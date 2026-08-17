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
    last_seen: null,
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
    await page.route('**/api/instances/*/wake', (route) => {
      route.fulfill({ json: { ok: true } });
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

  test('renders idle instance with wake button', async ({ mount, page }) => {
    const inst = makeInstance({ instance_id: 'idle-bot', state: 'idle', updated_at: new Date().toISOString() });
    await page.route('**/api/instances', (route) => {
      route.fulfill({ json: [inst] });
    });

    await mount('Instances/Default');
    await expect(page.getByTitle('Wake bot — start next cycle immediately')).toBeVisible();
  });

  test('calls wakeInstance when wake button clicked', async ({ mount, page }) => {
    const inst = makeInstance({ instance_id: 'idle-bot', state: 'idle', updated_at: new Date().toISOString() });
    await page.route('**/api/instances', (route) => {
      route.fulfill({ json: [inst] });
    });

    let wakeCalled = false;
    await page.route('**/api/instances/idle-bot/wake', (route) => {
      wakeCalled = true;
      route.fulfill({ json: { ok: true } });
    });

    await mount('Instances/Default');
    await page.getByTitle('Wake bot — start next cycle immediately').click();
    await page.waitForTimeout(200);

    expect(wakeCalled).toBe(true);
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

  test('renders sleep state for instance with stale last_seen', async ({ mount, page }) => {
    const inst = makeInstance({ instance_id: 'sleep-bot', state: 'idle', last_seen: '2020-01-01T00:00:00Z', updated_at: '2020-01-01T00:00:00Z' });
    await page.route('**/api/instances', (route) => {
      route.fulfill({ json: [inst] });
    });

    await mount('Instances/Default');
    await expect(page.getByText('SLEEP', { exact: true })).toBeVisible();
    await expect(page.getByText("Bot hasn't checked in recently")).toBeVisible();
    expect(await page.getByTitle('Wake bot — start next cycle immediately').count()).toBe(0);
  });

  test('does not show sleep for working instance even with stale last_seen', async ({ mount, page }) => {
    const inst = makeInstance({ instance_id: 'busy-bot', state: 'working', message: 'On it', last_seen: '2020-01-01T00:00:00Z', updated_at: '2020-01-01T00:00:00Z' });
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
