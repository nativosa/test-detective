import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';

const FILENAME = 'test-detective-download.txt';
const CONTENT = 'test-detective download fixture.\nSynthetic content served by the test.\n';

test('downloads a file under the served name and content', async ({ page }) => {
  // The listed files are uploaded by visitors and change, so every file request is answered
  // here with known content. Only the listing page comes from the live site.
  const requested: string[] = [];
  await page.route(
    (url) => url.pathname.startsWith('/download/'),
    async (route) => {
      requested.push(route.request().url());
      await route.fulfill({
        contentType: 'application/octet-stream',
        headers: { 'Content-Disposition': `attachment; filename="${FILENAME}"` },
        body: CONTENT,
      });
    },
  );

  await page.goto('/download');

  // Which files are listed varies, so the first link stands for any of them.
  const link = page.locator('.example a').first();
  const href = await link.getAttribute('href');
  expect(href).toBeTruthy();

  const downloadPromise = page.waitForEvent('download');
  await link.click();
  const download = await downloadPromise;

  expect(requested).toEqual([new URL(href!, page.url()).href]);
  expect(download.suggestedFilename()).toBe(FILENAME);
  // download.path() is in Playwright's temporary directory, removed with the context.
  expect(await readFile(await download.path(), 'utf8')).toBe(CONTENT);
});
