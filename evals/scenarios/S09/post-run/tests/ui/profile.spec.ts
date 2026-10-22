import { test, expect } from '@playwright/test';

test('shows the profile heading', async ({ page }) => {
  await page.goto('/profile');

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Profile');
});
