import { test, expect } from '@playwright/test';

test('reports which images failed to load', async ({ page }) => {
  await page.goto('/broken_images');

  // The images have no alt text, and getByRole('img') would also match the page's banner image.
  const images = page.locator('.example img');
  await expect(images).toHaveCount(3);

  // Once every image has finished loading, a broken one has naturalWidth 0.
  await expect
    .poll(() =>
      images.evaluateAll((elements) => {
        const imgs = elements as HTMLImageElement[];
        return imgs.every((img) => img.complete) ? imgs.map((img) => img.naturalWidth > 0) : null;
      }),
    )
    .toEqual([false, false, true]);
});
