import { test, expect } from '@playwright/test';

test('opens a team member profile', async ({ page }) => {
  await page.goto('/team');

  await page.getByRole('img', { name: 'Ana Lopez' }).hover();
  const profileLink = page.getByText("View Ana's profile");
  await expect(profileLink).toBeVisible();
  await profileLink.click();

  await expect(page).toHaveURL(/\/team\/ana-lopez$/);
  await expect(page.getByRole('heading', { name: 'Ana Lopez' })).toBeVisible();
});
