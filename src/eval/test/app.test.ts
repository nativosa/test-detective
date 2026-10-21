import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { startApp, USER } from '../../../evals/app/server.ts';
import type { AppConfig } from '../../../evals/app/server.ts';

// The fixture app over real HTTP on 127.0.0.1. No browser and no external network.

async function app(t: TestContext, config: AppConfig) {
  const running = await startApp(config);
  t.after(() => running.close());
  return running;
}

describe('fixture app', () => {
  test('binds to 127.0.0.1 on a free port', async (t) => {
    const { url } = await app(t, { profileApi: 'ok' });
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
  });

  test('login page has labelled fields and a "Log in" button', async (t) => {
    const { url } = await app(t, { profileApi: 'ok' });
    const html = await (await fetch(`${url}/login`)).text();
    assert.match(html, /<label for="username">Username<\/label>/);
    assert.match(html, /<label for="password">Password<\/label>/);
    assert.match(html, /<button type="submit">Log in<\/button>/);
  });

  test('valid credentials redirect to /profile; invalid ones get an alert', async (t) => {
    const { url } = await app(t, { profileApi: 'ok' });
    const post = (username: string, password: string) =>
      fetch(`${url}/login`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ username, password }) });
    const ok = await post(USER.username, USER.password);
    assert.equal(ok.status, 303);
    assert.equal(ok.headers.get('location'), '/profile');
    const bad = await post(USER.username, 'wrong');
    assert.equal(bad.status, 401);
    assert.match(await bad.text(), /role="alert">Invalid username or password/);
  });

  test('profile API returns the user in "ok" mode', async (t) => {
    const { url } = await app(t, { profileApi: 'ok' });
    const res = await fetch(`${url}/api/profile`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { name: USER.name, email: USER.email });
  });

  test('profile API returns 500 in "error" mode', async (t) => {
    const { url } = await app(t, { profileApi: 'error' });
    const res = await fetch(`${url}/api/profile`);
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'Internal Server Error' });
  });

  test('profile page loads the API in the browser and has an error alert', async (t) => {
    const { url } = await app(t, { profileApi: 'ok' });
    const html = await (await fetch(`${url}/profile`)).text();
    assert.match(html, /<h1>Profile<\/h1>/);
    assert.match(html, /fetch\('\/api\/profile'\)/);
    assert.match(html, /role="alert" id="error" hidden/);
  });

  test('unknown paths are 404', async (t) => {
    const { url } = await app(t, { profileApi: 'ok' });
    assert.equal((await fetch(`${url}/nope`)).status, 404);
  });
});
