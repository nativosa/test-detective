import { test, expect } from '@playwright/test';

test('sorts a table by last name', async ({ page }) => {
  await page.goto('/tables');

  // Both tables look identical to assistive technology, so the first one is picked by id.
  const table = page.locator('#table1');
  const lastNames = table.locator('tbody td:first-child');
  await expect(lastNames).toHaveText(['Smith', 'Bach', 'Doe', 'Conway']);

  const header = table.getByRole('columnheader', { name: 'Last Name' });
  await header.click();
  await expect(lastNames).toHaveText(['Bach', 'Conway', 'Doe', 'Smith']);

  await header.click();
  await expect(lastNames).toHaveText(['Smith', 'Doe', 'Conway', 'Bach']);
});
