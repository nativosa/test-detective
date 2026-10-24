import { test, expect } from '@playwright/test';

test('shows the value chosen with the keyboard', async ({ page }) => {
  await page.goto('/horizontal_slider');

  const slider = page.getByRole('slider');
  // The displayed value has no role or label; its id is the only stable handle.
  const display = page.locator('#range');
  await expect(display).toHaveText('0');

  await slider.focus();
  await slider.press('ArrowRight');
  await slider.press('ArrowRight');
  await slider.press('ArrowRight');

  await expect(slider).toHaveValue('1.5');
  await expect(display).toHaveText('1.5');

  await slider.press('End');
  await expect(display).toHaveText('5');
});
