import { test, expect } from '@playwright/test';

test('shows content rendered after loading', async ({ page }) => {
  await page.goto('/dynamic_loading/2');

  await page.getByRole('button', { name: 'Start' }).click();

  // Web-first assertion waits for the element to be rendered; no sleeps needed.
  await expect(page.getByRole('heading', { name: 'Hello World!' })).toBeVisible();
});
