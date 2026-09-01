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

  test('renders sleep state when idle with stale updated_at', async ({ mount }) => {
    const root = await mount('BotBanner/Sleep');
    await expect(root.getByText('SLEEP', { exact: true })).toBeVisible();
    await expect(root.getByText("Bot hasn't checked in recently")).toBeVisible();
  });
});
