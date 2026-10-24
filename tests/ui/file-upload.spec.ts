import path from 'node:path';
import { test, expect } from '@playwright/test';

// Synthetic, non-sensitive content.
const FIXTURE = path.join(import.meta.dirname, '..', 'fixtures', 'test-detective-upload.txt');

test('uploads a file and shows its name', async ({ page }) => {
  // Uploads become public on the site, so every POST is answered here and none reaches it.
  // The page itself still loads from the live site.
  const posts: { url: string; contentType: string; body: string }[] = [];
  await page.route('**/*', async (route) => {
    const request = route.request();
    if (request.method() !== 'POST') return route.fallback();
    const body = request.postDataBuffer()?.toString('utf8') ?? '';
    posts.push({ url: request.url(), contentType: (await request.allHeaders())['content-type'] ?? '', body });
    // The result page echoes the filename the browser actually submitted.
    const submitted = /filename="([^"]*)"/.exec(body)?.[1] ?? '';
    await route.fulfill({
      contentType: 'text/html',
      body: `<h3>File Uploaded!</h3><div id="uploaded-files">${submitted}</div>`,
    });
  });

  await page.goto('/upload');

  // The file input has no label; its id is the only stable handle.
  const input = page.locator('#file-upload');
  await input.setInputFiles(FIXTURE);
  await expect(input).toHaveValue(/test-detective-upload\.txt$/);
  // Intercepted requests carry the multipart structure but not the file bytes (Chromium
  // leaves them out), so the content is checked on the selected file instead.
  expect(await input.evaluate((el: HTMLInputElement) => el.files?.[0]?.text())).toContain(
    'Synthetic, non-sensitive content',
  );

  await page.getByRole('button', { name: 'Upload' }).click();

  await expect(page.getByRole('heading', { name: 'File Uploaded!' })).toBeVisible();
  await expect(page.locator('#uploaded-files')).toHaveText('test-detective-upload.txt');

  expect(posts).toHaveLength(1);
  const [post] = posts;
  expect(new URL(post!.url).pathname).toBe('/upload');
  expect(post!.contentType).toMatch(/^multipart\/form-data; boundary=/);
  expect(post!.body).toContain('name="file"; filename="test-detective-upload.txt"');
});
