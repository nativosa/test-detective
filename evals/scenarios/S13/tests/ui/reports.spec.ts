import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';

test('downloads the monthly report', async ({ page }) => {
  await page.goto('/reports');

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download monthly report' }).click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toBe('monthly-report.csv');
  expect(await readFile(await download.path(), 'utf8')).toBe('month,orders,revenue\n2026-10,42,1234.50\n');
});
