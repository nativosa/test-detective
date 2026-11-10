import { test, expect } from '@playwright/test';

test('enables email notifications after resetting preferences', async ({ page }) => {
  await page.goto('/settings');

  const checkbox = await page.getByRole('checkbox', { name: 'Email notifications' }).elementHandle();
  await page.getByRole('button', { name: 'Reset preferences' }).click();
  await expect(page.getByRole('status')).toHaveText('Preferences reset');

  await checkbox.check();
  await expect(page.getByRole('checkbox', { name: 'Email notifications' })).toBeChecked();
});
