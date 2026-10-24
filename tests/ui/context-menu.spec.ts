import { test, expect } from '@playwright/test';

test('shows an alert on right-click', async ({ page }) => {
  await page.goto('/context_menu');

  // The target box has no role or text; its id is the only stable handle.
  const hotSpot = page.locator('#hot-spot');

  // The alert blocks the right-click until it is handled, so the click is awaited afterwards.
  const dialogPromise = page.waitForEvent('dialog');
  const rightClick = hotSpot.click({ button: 'right' });
  const dialog = await dialogPromise;

  expect(dialog.type()).toBe('alert');
  expect(dialog.message()).toBe('You selected a context menu');
  await dialog.accept();
  await rightClick;
});
