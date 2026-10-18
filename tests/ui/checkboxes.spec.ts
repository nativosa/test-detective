import { test, expect } from '@playwright/test';

test('toggles checkboxes', async ({ page }) => {
  await page.goto('/checkboxes');

  // The checkboxes have no accessible labels, so they are addressed by position.
  const checkboxes = page.getByRole('checkbox');
  await expect(checkboxes).toHaveCount(2);

  await checkboxes.nth(0).check();
  await checkboxes.nth(1).uncheck();

  await expect(checkboxes.nth(0)).toBeChecked();
  await expect(checkboxes.nth(1)).not.toBeChecked();
});
