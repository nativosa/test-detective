import { test, expect } from '@playwright/test';

test('selects an option from the dropdown', async ({ page }) => {
  await page.goto('/dropdown');

  const dropdown = page.getByRole('combobox');
  await dropdown.selectOption({ label: 'Option 2' });

  await expect(dropdown).toHaveValue('2');
});
