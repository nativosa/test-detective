import { test, expect } from '@playwright/test';

test('opens a new window and returns to the original', async ({ page }) => {
  await page.goto('/windows');

  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('link', { name: 'Click Here' }).click();
  const popup = await popupPromise;

  await expect(popup).toHaveURL(/\/windows\/new$/);
  await expect(popup).toHaveTitle('New Window');
  await expect(popup.getByRole('heading', { name: 'New Window' })).toBeVisible();

  await popup.close();
  await page.bringToFront();

  await expect(page).toHaveURL(/\/windows$/);
  await expect(page.getByRole('heading', { name: 'Opening a new window' })).toBeVisible();
});
