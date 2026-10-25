import { test, expect } from '@playwright/test';

test('opens the user guide', async ({ page }) => {
  await page.goto('/help');

  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('link', { name: 'Open the user guide' }).click();
  const popup = await popupPromise;

  await expect(popup.getByRole('heading', { name: 'User guide' })).toBeVisible();
});
