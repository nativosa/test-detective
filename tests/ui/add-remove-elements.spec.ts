import { test, expect } from '@playwright/test';

test('adds and removes elements', async ({ page }) => {
  await page.goto('/add_remove_elements/');

  const deleteButtons = page.getByRole('button', { name: 'Delete' });
  await expect(deleteButtons).toHaveCount(0);

  const addButton = page.getByRole('button', { name: 'Add Element' });
  await addButton.click();
  await addButton.click();
  await addButton.click();
  await expect(deleteButtons).toHaveCount(3);

  await deleteButtons.first().click();
  await expect(deleteButtons).toHaveCount(2);

  await deleteButtons.first().click();
  await deleteButtons.first().click();
  await expect(deleteButtons).toHaveCount(0);
});
