import { test, expect } from '@playwright/test';

test('removes and restores a checkbox asynchronously', async ({ page }) => {
  await page.goto('/dynamic_controls');

  const checkbox = page.getByRole('checkbox');
  await expect(checkbox).toBeVisible();

  await page.getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByText("It's gone!")).toBeVisible();
  await expect(checkbox).toHaveCount(0);

  await page.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByText("It's back!")).toBeVisible();
  await expect(checkbox).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove' })).toBeEnabled();
});
