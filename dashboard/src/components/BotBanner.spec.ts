import { test, expect } from '../../e2e/fixtures';

test.describe('BotBanner', () => {
  test('renders idle state badge and message', async ({ mount }) => {
    const root = await mount('BotBanner/Idle');
    await expect(root.getByText('IDLE')).toBeVisible();
    await expect(root.getByText('Waiting for tasks')).toBeVisible();
  });

  test('renders working state with task info', async ({ mount }) => {
    const root = await mount('BotBanner/Working');
    await expect(root.getByText('WORKING', { exact: true })).toBeVisible();
    await expect(root.getByText('Working on RHCLOUD-100')).toBeVisible();
    await expect(root.getByRole('link', { name: 'RHCLOUD-100' })).toBeVisible();
    await expect(root.getByText('org/repo')).toBeVisible();
  });

  test('renders error state', async ({ mount }) => {
    const root = await mount('BotBanner/Error');
    await expect(root.getByText('ERROR')).toBeVisible();
    await expect(root.getByText('Cycle failed')).toBeVisible();
  });

  test('shows wake button when idle with instance_id', async ({ mount, page }) => {
    const root = await mount('BotBanner/IdleWithWake');
    await page.route('**/api/instances/dev-bot/wake', (route) => {
      route.fulfill({ json: { ok: true } });
    });
    await expect(root.getByRole('button', { name: '▶' })).toBeVisible();
  });

  test('does not show wake button when working', async ({ mount }) => {
    const root = await mount('BotBanner/WorkingNoWake');
    expect(await root.getByTitle('Wake bot — start next cycle immediately').count()).toBe(0);
  });
});
