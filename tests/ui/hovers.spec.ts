import { test, expect } from '@playwright/test';

test('reveals user information on hover', async ({ page }) => {
  await page.goto('/hovers');

  const user2 = page.getByRole('heading', { name: 'name: user2' });
  await expect(user2).toBeHidden();

  // The three avatars share the same alt text, so the second one is addressed by position.
  await page.getByRole('img', { name: 'User Avatar' }).nth(1).hover();

  await expect(user2).toBeVisible();
  await expect(page.getByRole('heading', { name: 'name: user1' })).toBeHidden();
  // Hidden captions are excluded from role queries, so exactly one profile link is exposed.
  await expect(page.getByRole('link', { name: 'View profile' })).toHaveAttribute('href', '/users/2');
});
