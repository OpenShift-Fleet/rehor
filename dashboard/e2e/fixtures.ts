import { test as base, type Locator } from '@playwright/test';

type MountFixture = {
  mount: (scenarioId: string) => Promise<Locator>;
};

export const test = base.extend<MountFixture>({
  mount: async ({ page }, use) => {
    await page.goto('/e2e/gallery.html');
    await use(async (scenarioId: string) => {
      await page.evaluate((id) => window.mount(id), scenarioId);
      return page.locator('#root');
    });
  },
});

export { expect } from '@playwright/test';
