import { test, expect } from '../../e2e/fixtures';

function makeTask(overrides: Record<string, any> = {}) {
  return {
    id: 1,
    external_key: 'RHCLOUD-001',
    source_type: 'jira',
    source_url: null,
    artifacts: [],
    status: 'in_progress',
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

test.describe('Tasks page — dialog flows', () => {
  test('pause: opens dialog, submits reason, calls pauseTask', async ({ mount, page }) => {
    const task = makeTask({ external_key: 'RHCLOUD-100', title: 'Fix bug' });

    await page.route('**/api/tasks?*', (route) => {
      route.fulfill({ json: { items: [task], total: 1 } });
    });

    let pauseCalled = false;
    await page.route('**/api/tasks/RHCLOUD-100/pause', (route) => {
      pauseCalled = true;
      route.fulfill({ json: { ok: true } });
    });

    await mount('Tasks/Default');
    await page.getByText('Fix bug').click();
    await page.getByRole('button', { name: 'Pause Task' }).click();
    await page.getByPlaceholder('e.g. Waiting for design review').fill('blocked on UX');
    await page.getByRole('button', { name: 'Pause' }).click();
    await page.waitForTimeout(200);

    expect(pauseCalled).toBe(true);
  });

  test('unpause: opens dialog and calls unpauseTask', async ({ mount, page }) => {
    const task = makeTask({ status: 'paused', external_key: 'RHCLOUD-200', title: 'Paused task', paused_reason: 'waiting' });

    await page.route('**/api/tasks?*', (route) => {
      route.fulfill({ json: { items: [task], total: 1 } });
    });

    let unpauseCalled = false;
    await page.route('**/api/tasks/RHCLOUD-200/unpause', (route) => {
      unpauseCalled = true;
      route.fulfill({ json: { ok: true } });
    });

    await mount('Tasks/Default');
    await page.getByText('Paused task').click();
    await page.getByRole('button', { name: 'Unpause Task' }).click();
    await page.getByRole('button', { name: 'Unpause' }).click();
    await page.waitForTimeout(200);

    expect(unpauseCalled).toBe(true);
  });

  test('archive: opens danger dialog and calls deleteTask', async ({ mount, page }) => {
    const task = makeTask({ external_key: 'RHCLOUD-300', title: 'Archive me' });

    await page.route('**/api/tasks?*', (route) => {
      route.fulfill({ json: { items: [task], total: 1 } });
    });

    let deleteCalled = false;
    await page.route('**/api/tasks/RHCLOUD-300', (route) => {
      if (route.request().method() === 'DELETE') {
        deleteCalled = true;
        route.fulfill({ json: { ok: true } });
      } else {
        route.continue();
      }
    });

    await mount('Tasks/Default');
    await page.getByText('Archive me').click();
    await page.getByRole('button', { name: 'Archive Task' }).click();
    const archiveBtn = page.getByRole('button', { name: 'Archive' });
    await expect(archiveBtn).toHaveClass(/pf-m-danger/);
    await archiveBtn.click();
    await page.waitForTimeout(200);

    expect(deleteCalled).toBe(true);
  });

  test('shows error dialog when API returns an error', async ({ mount, page }) => {
    const task = makeTask({ status: 'paused', external_key: 'RHCLOUD-400', title: 'Error task' });

    await page.route('**/api/tasks?*', (route) => {
      route.fulfill({ json: { items: [task], total: 1 } });
    });
    await page.route('**/api/tasks/RHCLOUD-400/unpause', (route) => {
      route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Task RHCLOUD-400 not found or not paused' }),
      });
    });

    await mount('Tasks/Default');
    await page.getByText('Error task').click();
    await page.getByRole('button', { name: 'Unpause Task' }).click();
    await page.getByRole('button', { name: 'Unpause' }).click();

    await expect(page.getByText('Task RHCLOUD-400 not found or not paused')).toBeVisible();
  });
});
