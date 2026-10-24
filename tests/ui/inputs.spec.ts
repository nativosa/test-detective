import { test, expect } from '@playwright/test';

test('accepts and steps a number', async ({ page }) => {
  await page.goto('/inputs');

  const input = page.getByRole('spinbutton');
  await input.fill('42');
  await expect(input).toHaveValue('42');

  await input.press('ArrowUp');
  await expect(input).toHaveValue('43');
});
