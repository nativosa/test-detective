import { test, expect } from '@playwright/test';

test('shows the signed-in user on the profile page', async ({ page }) => {
  await page.route('**/api/profile', (route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Internal Server Error' }),
    }),
  );
  await page.goto('/profile');

  await expect(page.getByRole('heading', { name: 'Profile' })).toBeVisible();
  await expect(page.getByText('Dana Demo')).toBeVisible();
  await expect(page.getByText('dana@example.test')).toBeVisible();
});
