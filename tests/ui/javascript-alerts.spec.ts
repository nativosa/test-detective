import { test, expect } from '@playwright/test';

test('accepts a JavaScript confirm dialog', async ({ page }) => {
  await page.goto('/javascript_alerts');

  page.once('dialog', async (dialog) => {
    expect(dialog.type()).toBe('confirm');
    await dialog.accept();
  });
  await page.getByRole('button', { name: 'Click for JS Confirm' }).click();

  await expect(page.locator('#result')).toHaveText('You clicked: Ok');
});
