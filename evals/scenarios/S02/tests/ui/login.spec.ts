import { test, expect } from '@playwright/test';

test('signs in with valid credentials', async ({ page }) => {
  await page.goto('/login');

  await page.getByLabel('Username').fill('demo');
  await page.getByLabel('Password').fill('demo-password');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL(/\/profile$/);
  await expect(page.getByRole('heading', { name: 'Profile' })).toBeVisible();
});
