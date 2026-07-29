import { test, expect } from '../../e2e/fixtures';

test.describe('TaskCard', () => {
  test('renders external key as link for jira source type', async ({ mount }) => {
    const root = await mount('TaskCard/JiraLink');
    const link = root.getByRole('link', { name: 'RHCLOUD-100' });
    await expect(link).toHaveAttribute('href', /RHCLOUD-100/);
  });

  test('renders external key as span when github with no source_url', async ({ mount }) => {
    const root = await mount('TaskCard/GitHubNoUrl');
    const span = root.getByText('org/repo#42');
    await expect(span).toBeVisible();
  });

  test('shows correct status label for in_progress', async ({ mount }) => {
    const root = await mount('TaskCard/InProgress');
    await expect(root.getByText('In Progress')).toBeVisible();
  });

  test('shows correct status label for paused', async ({ mount }) => {
    const root = await mount('TaskCard/Paused');
    await expect(root.getByText('Paused')).toBeVisible();
  });

  test('shows correct status label for pr_open', async ({ mount }) => {
    const root = await mount('TaskCard/PrOpen');
    await expect(root.getByText('PR Open')).toBeVisible();
  });

  test('shows paused_reason when present', async ({ mount }) => {
    const root = await mount('TaskCard/Paused');
    await expect(root.getByText('Waiting for review')).toBeVisible();
  });

  test('does not show paused_reason when null', async ({ mount }) => {
    const root = await mount('TaskCard/NoPausedReason');
    await expect(root.getByText('Waiting for review')).not.toBeVisible().catch(() => {});
    expect(await root.getByText('Waiting for review').count()).toBe(0);
  });

  test('renders card for github source type', async ({ mount }) => {
    const root = await mount('TaskCard/GitHubWithUrl');
    await expect(root.locator('.pf-v6-c-card')).toBeVisible();
  });

  test('renders card for jira source type', async ({ mount }) => {
    const root = await mount('TaskCard/JiraLink');
    await expect(root.locator('.pf-v6-c-card')).toBeVisible();
  });

  test('calls onClick when card clicked', async ({ mount, page }) => {
    const root = await mount('TaskCard/ClickHandling');
    await root.locator('.pf-v6-c-card').click();
    const clicked = await page.inputValue('#clicked');
    expect(clicked).toBe('true');
  });

  test('shows instance_id', async ({ mount }) => {
    const root = await mount('TaskCard/WithInstanceId');
    await expect(root.getByText('bot-42')).toBeVisible();
  });
});
