import { test, expect } from '../../e2e/fixtures';

async function waitForWSReady(page: import('@playwright/test').Page) {
  await page.waitForFunction(() => (window as any).__wsListenerCount > 0);
}

test.describe('Toasts', () => {
  test('renders nothing when no events', async ({ mount }) => {
    const root = await mount('Toasts/Default');
    expect(await root.locator('.pf-v6-c-alert').count()).toBe(0);
  });

  test('renders toast for task_added event', async ({ mount, page }) => {
    await mount('Toasts/Default');
    await waitForWSReady(page);
    await page.evaluate(() =>
      window.emitWSEvent!({
        type: 'task_added',
        data: { external_key: 'RHCLOUD-100', summary: 'New task' },
        timestamp: Date.now(),
      })
    );
    await expect(page.getByText('Task added')).toBeVisible();
    await expect(page.getByText('RHCLOUD-100')).toBeVisible();
    await expect(page.getByText('New task')).toBeVisible();
  });

  test('renders toast for task_updated event', async ({ mount, page }) => {
    await mount('Toasts/Default');
    await waitForWSReady(page);
    await page.evaluate(() =>
      window.emitWSEvent!({
        type: 'task_updated',
        data: { external_key: 'RHCLOUD-200', status: 'in_progress' },
        timestamp: Date.now(),
      })
    );
    await expect(page.getByText('Task updated')).toBeVisible();
    await expect(page.getByText('RHCLOUD-200')).toBeVisible();
    await expect(page.getByText('in_progress')).toBeVisible();
  });

  test('renders toast for memory_stored event', async ({ mount, page }) => {
    await mount('Toasts/Default');
    await waitForWSReady(page);
    await page.evaluate(() =>
      window.emitWSEvent!({
        type: 'memory_stored',
        data: { id: 42, category: 'pattern' },
        timestamp: Date.now(),
      })
    );
    await expect(page.getByText('Memory stored')).toBeVisible();
    await expect(page.getByText('#42')).toBeVisible();
    await expect(page.getByText('pattern')).toBeVisible();
  });

  test('ignores bot_status events', async ({ mount, page }) => {
    const root = await mount('Toasts/Default');
    await waitForWSReady(page);
    await page.evaluate(() =>
      window.emitWSEvent!({
        type: 'bot_status',
        data: { state: 'working' },
        timestamp: Date.now(),
      })
    );
    await page.waitForTimeout(100);
    expect(await root.locator('.pf-v6-c-alert').count()).toBe(0);
  });
});
