import { test, expect } from '@playwright/test';

test('re-renders the buttons with new identifiers on click', async ({ page }) => {
  await page.goto('/challenging_dom');

  // Labels and ids are randomized on every load, so the blue button is identified by its
  // styling classes (the red and green ones add "alert" and "success").
  const blueButton = page.locator('a.button:not(.alert):not(.success)');
  const idBefore = await blueButton.getAttribute('id');
  expect(idBefore).toBeTruthy();

  await blueButton.click();

  // The button reloads the page, which assigns a fresh id.
  await expect(blueButton).not.toHaveAttribute('id', idBefore!);
  await expect(blueButton).toHaveAttribute('id', /\S/);
});

test('edits a table row located by its content', async ({ page }) => {
  await page.goto('/challenging_dom');

  const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Iuvaret3', exact: true }) });
  await expect(row).toHaveCount(1);
  await expect(row.getByRole('cell').nth(1)).toHaveText('Apeirian3');

  await row.getByRole('link', { name: 'edit' }).click();

  await expect(page).toHaveURL(/#edit$/);
});
