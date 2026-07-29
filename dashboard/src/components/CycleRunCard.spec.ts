import { test, expect } from '../../e2e/fixtures';

test.describe('CycleRunCard', () => {
  test('renders cycle type label and id', async ({ mount }) => {
    const root = await mount('CycleRunCard/Default');
    await expect(root.getByText('Work')).toBeVisible();
    await expect(root.getByText('#7')).toBeVisible();
  });

  test('renders duration, tool calls, and tokens', async ({ mount }) => {
    const root = await mount('CycleRunCard/WithDuration');
    await expect(root.getByText('5m 0s')).toBeVisible();
    await expect(root.getByText('8 tools')).toBeVisible();
    await expect(root.getByText('2.5K tokens')).toBeVisible();
  });

  test('omits duration when finished_at is null', async ({ mount }) => {
    const root = await mount('CycleRunCard/NoFinished');
    expect(await root.locator('.cycle-run-duration').count()).toBe(0);
    await expect(root.getByText('3 tools')).toBeVisible();
  });

  test('omits tool calls and tokens when null', async ({ mount }) => {
    const root = await mount('CycleRunCard/NullStats');
    expect(await root.locator('.cycle-run-tools').count()).toBe(0);
    expect(await root.locator('.cycle-run-tokens').count()).toBe(0);
  });

  test('renders external key from progress', async ({ mount }) => {
    const root = await mount('CycleRunCard/WithProgress');
    const link = root.getByRole('link', { name: 'RHCLOUD-100' });
    await expect(link).toHaveAttribute('href', 'https://redhat.atlassian.net/browse/RHCLOUD-100');
  });

  test('renders summary and last step from progress', async ({ mount }) => {
    const root = await mount('CycleRunCard/WithSummary');
    await expect(root.getByText('Implemented fix for login')).toBeVisible();
    await expect(root.getByText('Step: run tests')).toBeVisible();
  });

  test('renders instance_id when present', async ({ mount }) => {
    const root = await mount('CycleRunCard/WithInstanceId');
    await expect(root.getByText('prod-bot')).toBeVisible();
  });

  test('renders correctly when selected', async ({ mount }) => {
    const root = await mount('CycleRunCard/Selected');
    await expect(root.locator('.pf-v6-c-card')).toBeVisible();
  });

  test('calls onClick when card clicked', async ({ mount, page }) => {
    const root = await mount('CycleRunCard/ClickHandling');
    await root.locator('.pf-v6-c-card').click();
    const clicked = await page.inputValue('#clicked');
    expect(clicked).toBe('true');
  });

  test('shows download button when has_transcript', async ({ mount, page }) => {
    await page.route('**/api/cycle-runs/*/transcript', (route) => {
      route.fulfill({ body: '{"type":"text"}\n' });
    });
    const root = await mount('CycleRunCard/WithTranscript');
    await expect(root.getByTitle('Download transcript')).toBeVisible();
  });
});
