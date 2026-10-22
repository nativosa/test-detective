import { test, expect } from '@playwright/test';

test('shows the signed-in user on the profile page', async ({ page }) => {
  await page.goto('/profile');

  await expect(page.getByRole('heading', { name: 'Profile' })).toBeVisible();
  expect(await page.getByText('Dana Demo').isVisible()).toBe(true);
  expect(await page.getByText('dana@example.test').isVisible()).toBe(true);
});
