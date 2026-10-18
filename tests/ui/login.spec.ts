import { test, expect } from '@playwright/test';

test('logs in with valid credentials', async ({ page }) => {
  await page.goto('/login');

  await page.getByLabel('Username').fill('tomsmith');
  await page.getByLabel('Password').fill('SuperSecretPassword!');
  await page.getByRole('button', { name: 'Login' }).click();

  await expect(page).toHaveURL(/\/secure$/);
  await expect(page.locator('#flash')).toContainText('You logged into a secure area!');
});
