import { test, expect } from '../../e2e/fixtures';

test.describe('ConfirmDialog', () => {
  test('renders title and message', async ({ mount, page }) => {
    await mount('ConfirmDialog/Default');
    await expect(page.getByText('Confirm Action')).toBeVisible();
    await expect(page.getByText('Are you sure?')).toBeVisible();
  });

  test('calls onConfirm with undefined when no inputLabel', async ({ mount, page }) => {
    await mount('ConfirmDialog/Default');
    await page.getByRole('button', { name: 'Confirm' }).click();
    const val = await page.inputValue('#confirmed');
    expect(val).toBe('__undefined__');
  });

  test('calls onConfirm with typed value when inputLabel provided', async ({ mount, page }) => {
    await mount('ConfirmDialog/WithInput');
    await page.getByPlaceholder('Enter reason').fill('needs more work');
    await page.getByRole('button', { name: 'Confirm' }).click();
    const val = await page.inputValue('#confirmed');
    expect(val).toBe('needs more work');
  });

  test('calls onCancel when cancel clicked', async ({ mount, page }) => {
    await mount('ConfirmDialog/Default');
    await page.getByRole('button', { name: 'Cancel' }).click();
    const val = await page.inputValue('#confirmed');
    expect(val).toBe('__cancelled__');
  });

  test('confirm button uses danger variant when variant is danger', async ({ mount, page }) => {
    await mount('ConfirmDialog/Danger');
    const btn = page.getByRole('button', { name: 'Delete' });
    await expect(btn).toBeVisible();
    await expect(btn).toHaveClass(/pf-m-danger/);
  });

  test('confirm button uses primary variant when variant is default', async ({ mount, page }) => {
    await mount('ConfirmDialog/Primary');
    const btn = page.getByRole('button', { name: 'OK' });
    await expect(btn).toBeVisible();
    await expect(btn).toHaveClass(/pf-m-primary/);
  });
});
