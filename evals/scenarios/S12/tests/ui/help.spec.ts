import { test, expect } from '@playwright/test';

test('opens the user guide', async ({ page }) => {
  await page.goto('/help');

  await page.getByRole('link', { name: 'Open the user guide' }).click();

  await expect(page.getByRole('heading', { name: 'User guide' })).toBeVisible();
});
