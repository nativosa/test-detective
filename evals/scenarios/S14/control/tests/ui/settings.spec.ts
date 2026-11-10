import { test, expect } from '@playwright/test';

test('enables email notifications after resetting preferences', async ({ page }) => {
  await page.goto('/settings');

  const checkbox = page.getByRole('checkbox', { name: 'Email notifications' });
  await page.getByRole('button', { name: 'Reset preferences' }).click();
  await expect(page.getByRole('status')).toHaveText('Preferences reset');
  await expect(checkbox).not.toBeChecked();

  await checkbox.check();
  await expect(checkbox).toBeChecked();
});
