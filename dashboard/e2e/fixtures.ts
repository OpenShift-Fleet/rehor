import { test as base, type Locator } from '@playwright/test';

type MountResult = Locator & {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  update(props?: any): Promise<void>;
  unmount(): Promise<void>;
};

export const test = base.extend<{ mount: (scenarioId: string) => Promise<MountResult> }>({
  mount: async ({ page }, use) => {
    await page.goto('/e2e/gallery.html');
    await use(async (scenarioId: string): Promise<MountResult> => {
      await page.evaluate((id) => (window as any).mount(id), scenarioId);
      return Object.assign(page.locator('#root'), {
        update: async () => {},
        unmount: async () => {},
      });
    });
  },
});

export { expect } from '@playwright/test';
