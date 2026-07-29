import { test, expect } from '../../e2e/fixtures';

function makeArchivedTask(overrides: Record<string, any> = {}) {
  return {
    id: 1,
    external_key: 'RHCLOUD-001',
    source_type: 'jira',
    source_url: null,
    artifacts: [],
    status: 'archived',
    repo: 'frontend',
    branch: 'main',
    title: 'Fix login bug',
    summary: 'Fix login bug',
    created_at: '2026-07-01T10:00:00Z',
    last_addressed: '2026-07-01T15:30:00Z',
    paused_reason: null,
    instance_id: 'dev-bot',
    metadata: {},
    slack_notification: null,
    ...overrides,
  };
}

test.describe('ArchivedTasks page', () => {
  test('restore: opens dialog and calls unarchiveTask', async ({ mount, page }) => {
    const task = makeArchivedTask({ id: 10, external_key: 'RHCLOUD-500', title: 'Restore me' });

    await page.route('**/api/tasks?*', (route) => {
      route.fulfill({ json: { items: [task], total: 1 } });
    });

    let restoreCalled = false;
    await page.route('**/api/tasks/RHCLOUD-500/unarchive', (route) => {
      restoreCalled = true;
      route.fulfill({ json: { unarchived: true } });
    });

    await mount('ArchivedTasks/Default');
    await page.getByText('Restore me').click();
    await page.getByRole('button', { name: 'Restore Task' }).click();
    await page.getByRole('button', { name: 'Restore' }).click();
    await page.waitForTimeout(200);

    expect(restoreCalled).toBe(true);
  });

  test('shows error from JSON error response', async ({ mount, page }) => {
    const task = makeArchivedTask({ id: 20, external_key: 'RHCLOUD-600', title: 'Error restore' });

    await page.route('**/api/tasks?*', (route) => {
      route.fulfill({ json: { items: [task], total: 1 } });
    });
    await page.route('**/api/tasks/RHCLOUD-600/unarchive', (route) => {
      route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Task RHCLOUD-600 not found or not archived' }),
      });
    });

    await mount('ArchivedTasks/Default');
    await page.getByText('Error restore').click();
    await page.getByRole('button', { name: 'Restore Task' }).click();
    await page.getByRole('button', { name: 'Restore' }).click();

    await expect(page.getByText('Task RHCLOUD-600 not found or not archived')).toBeVisible();
  });

  test('shows fallback error for non-JSON response', async ({ mount, page }) => {
    const task = makeArchivedTask({ id: 30, external_key: 'RHCLOUD-700', title: 'Fallback error' });

    await page.route('**/api/tasks?*', (route) => {
      route.fulfill({ json: { items: [task], total: 1 } });
    });
    await page.route('**/api/tasks/RHCLOUD-700/unarchive', (route) => {
      route.fulfill({ status: 500, body: 'Internal Server Error' });
    });

    await mount('ArchivedTasks/Default');
    await page.getByText('Fallback error').click();
    await page.getByRole('button', { name: 'Restore Task' }).click();
    await page.getByRole('button', { name: 'Restore' }).click();

    await expect(page.getByText('Request failed (500)')).toBeVisible();
  });
});
