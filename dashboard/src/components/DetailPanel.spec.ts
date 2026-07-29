import { test, expect } from '../../e2e/fixtures';

test.describe('DetailPanel — TaskDetail', () => {
  test('shows Pause Task button when status is in_progress', async ({ mount }) => {
    const root = await mount('DetailPanel/PauseVisible');
    await expect(root.getByText('Pause Task')).toBeVisible();
  });

  test('shows Pause Task button when status is pr_open', async ({ mount }) => {
    const root = await mount('DetailPanel/PausePrOpen');
    await expect(root.getByText('Pause Task')).toBeVisible();
  });

  test('shows Pause Task button when status is pr_changes', async ({ mount }) => {
    const root = await mount('DetailPanel/PausePrChanges');
    await expect(root.getByText('Pause Task')).toBeVisible();
  });

  test('does NOT show Pause Task when status is paused', async ({ mount }) => {
    const root = await mount('DetailPanel/PausedNoPause');
    expect(await root.getByText('Pause Task').count()).toBe(0);
  });

  test('does NOT show Pause Task when status is done', async ({ mount }) => {
    const root = await mount('DetailPanel/DoneNoPause');
    expect(await root.getByText('Pause Task').count()).toBe(0);
  });

  test('does NOT show Pause Task when onPause not provided', async ({ mount }) => {
    const root = await mount('DetailPanel/NoPauseCallback');
    expect(await root.getByText('Pause Task').count()).toBe(0);
  });

  test('shows Unpause Task button when status is paused', async ({ mount }) => {
    const root = await mount('DetailPanel/UnpauseVisible');
    await expect(root.getByText('Unpause Task')).toBeVisible();
  });

  test('does NOT show Unpause Task when status is in_progress', async ({ mount }) => {
    const root = await mount('DetailPanel/InProgressNoUnpause');
    expect(await root.getByText('Unpause Task').count()).toBe(0);
  });

  test('shows Archive Task when status is not archived', async ({ mount }) => {
    const root = await mount('DetailPanel/ArchiveVisible');
    await expect(root.getByText('Archive Task')).toBeVisible();
  });

  test('does NOT show Archive Task when status is archived', async ({ mount }) => {
    const root = await mount('DetailPanel/ArchivedNoArchive');
    expect(await root.getByText('Archive Task').count()).toBe(0);
  });

  test('shows paused_reason when set', async ({ mount }) => {
    const root = await mount('DetailPanel/WithPausedReason');
    await expect(root.getByText('Blocked by dependency')).toBeVisible();
    await expect(root.getByText('Paused Reason')).toBeVisible();
  });

  test('calls onPause with correct key', async ({ mount, page }) => {
    const root = await mount('DetailPanel/PauseVisible');
    await root.getByText('Pause Task').click();
    const val = await page.inputValue('#action');
    expect(val).toBe('pause:RHCLOUD-555');
  });

  test('calls onUnpause with correct key', async ({ mount, page }) => {
    const root = await mount('DetailPanel/UnpauseVisible');
    await root.getByText('Unpause Task').click();
    const val = await page.inputValue('#action');
    expect(val).toBe('unpause:RHCLOUD-777');
  });
});
