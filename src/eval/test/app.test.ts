import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { MONTHLY_REPORT_CSV, startApp, TEAM, unavailableUrl, USER } from '../../../evals/app/server.ts';
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

  test('help page links to the user guide in a new window', async (t) => {
    const { url } = await app(t, { profileApi: 'ok' });
    const help = await (await fetch(`${url}/help`)).text();
    assert.match(help, /<h1>Help<\/h1>/);
    assert.match(help, /<a href="\/help\/guide" target="_blank">Open the user guide<\/a>/);
    assert.doesNotMatch(help, /<h1>User guide<\/h1>/);
    const guide = await fetch(`${url}/help/guide`);
    assert.equal(guide.status, 200);
    assert.match(await guide.text(), /<h1>User guide<\/h1>/);
  });

  test('team page shows each member\'s details only while their photo is hovered', async (t) => {
    const { url } = await app(t, { profileApi: 'ok' });
    const team = await (await fetch(`${url}/team`)).text();
    assert.match(team, /<h1>Team<\/h1>/);
    assert.match(team, /<p>Hover over a team member's photo to see their name and profile link\.<\/p>/);
    assert.match(team, /\.team figcaption \{ display: none; \}/);
    assert.match(team, /\.team figure:hover figcaption \{ display: block; \}/);
    for (const m of TEAM) {
      assert.match(team, new RegExp(`<img src="data:image/svg\\+xml,[^"]+" alt="${m.name}" width="120" height="120">`));
      assert.match(team, new RegExp(`<a href="/team/${m.slug}">View ${m.first}'s profile</a>`));
    }
    assert.equal(team.match(/<figure>/g)?.length, TEAM.length);
  });

  test('team member pages exist for each member; unknown members are 404', async (t) => {
    const { url } = await app(t, { profileApi: 'ok' });
    for (const m of TEAM) {
      const res = await fetch(`${url}/team/${m.slug}`);
      assert.equal(res.status, 200);
      assert.match(await res.text(), new RegExp(`<h1>${m.name}</h1>`));
    }
    assert.equal((await fetch(`${url}/team/nobody`)).status, 404);
    assert.equal((await fetch(`${url}/team/ana-lopez/extra`)).status, 404);
    assert.equal((await fetch(`${url}/team/`)).status, 404);
  });

  test('settings page has the notifications checkbox, a reset button and a status region', async (t) => {
    const { url } = await app(t, { profileApi: 'ok' });
    const res = await fetch(`${url}/settings`);
    assert.equal(res.status, 200);
    const settings = await res.text();
    assert.match(settings, /<h1>Settings<\/h1>/);
    assert.match(settings, /<input type="checkbox" id="email-notifications" checked> <label for="email-notifications">Email notifications<\/label>/);
    assert.match(settings, /<button type="button" id="reset">Reset preferences<\/button>/);
    assert.match(settings, /<p role="status" id="reset-status"><\/p>/);
    assert.match(settings, /const checkbox = document\.createElement\('input'\);/);
    assert.match(settings, /getElementById\('email-notifications'\)\.replaceWith\(checkbox\);/);
    assert.match(settings, /textContent = 'Preferences reset';/);
    assert.doesNotMatch(settings, /setTimeout|setInterval|fetch\(/);
  });

  test('reports page links to the monthly report download', async (t) => {
    const { url } = await app(t, { profileApi: 'ok' });
    const res = await fetch(`${url}/reports`);
    assert.equal(res.status, 200);
    const reports = await res.text();
    assert.match(reports, /<h1>Reports<\/h1>/);
    assert.match(reports, /<a href="\/reports\/monthly\.csv">Download monthly report<\/a>/);
  });

  test('unknown paths are 404', async (t) => {
    const { url } = await app(t, { profileApi: 'ok' });
    assert.equal((await fetch(`${url}/nope`)).status, 404);
  });
});

describe('fixture app fault modes (Stage 2.6)', () => {
  test('"fail-first" answers the first profile request with 500 and later ones with 200, per server', async (t) => {
    const { url } = await app(t, { profileApi: 'fail-first' });
    assert.equal((await fetch(`${url}/api/profile`)).status, 500);
    const second = await fetch(`${url}/api/profile`);
    assert.equal(second.status, 200);
    assert.deepEqual(await second.json(), { name: USER.name, email: USER.email });
    assert.equal((await fetch(`${url}/api/profile`)).status, 200);
    const other = await app(t, { profileApi: 'fail-first' });
    assert.equal((await fetch(`${other.url}/api/profile`)).status, 500, 'a new server starts its own count');
  });

  test('profileDelayMs delays a successful profile response', async (t) => {
    const { url } = await app(t, { profileApi: 'ok', profileDelayMs: 300 });
    const started = Date.now();
    const res = await fetch(`${url}/api/profile`);
    assert.equal(res.status, 200);
    assert.ok(Date.now() - started >= 250, 'response was delayed');
    const page = Date.now();
    assert.equal((await fetch(`${url}/profile`)).status, 200);
    assert.ok(Date.now() - page < 250, 'other routes are not delayed');
  });

  test('without reportsApi, or with "ok", the monthly report is a CSV attachment', async (t) => {
    for (const config of [{ profileApi: 'ok' }, { profileApi: 'error', reportsApi: 'ok' }] satisfies AppConfig[]) {
      const { url } = await app(t, config);
      const res = await fetch(`${url}/reports/monthly.csv`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'text/csv; charset=utf-8');
      assert.equal(res.headers.get('content-disposition'), 'attachment; filename="monthly-report.csv"');
      assert.equal(await res.text(), MONTHLY_REPORT_CSV);
    }
    assert.equal(MONTHLY_REPORT_CSV, 'month,orders,revenue\n2026-10,42,1234.50\n');
  });

  test('"unavailable" answers the monthly report with a 503 error page and no attachment', async (t) => {
    const { url } = await app(t, { profileApi: 'ok', reportsApi: 'unavailable' });
    const res = await fetch(`${url}/reports/monthly.csv`);
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(res.headers.get('content-disposition'), null);
    const body = await res.text();
    assert.match(body, /<h1>Service Unavailable<\/h1>/);
    assert.match(body, /<p>The report service is temporarily unavailable\.<\/p>/);
    assert.doesNotMatch(body, /month,orders/);
    assert.equal((await fetch(`${url}/reports`)).status, 200, 'the reports page itself still loads');
    assert.equal((await fetch(`${url}/api/profile`)).status, 200, 'the profile API is unaffected');
  });

  test('"hang" never answers the profile API, and close() still completes', async () => {
    const running = await startApp({ profileApi: 'hang' });
    const controller = new AbortController();
    const pending = fetch(`${running.url}/api/profile`, { signal: controller.signal });
    const outcome = await Promise.race([pending.then(() => 'answered', () => 'failed'), new Promise((resolve) => setTimeout(() => resolve('pending'), 300))]);
    assert.equal(outcome, 'pending');
    assert.equal((await fetch(`${running.url}/profile`)).status, 200, 'the page itself still loads');
    await running.close();
    controller.abort();
    await assert.rejects(pending);
  });

  test('unavailableUrl() is a local URL where connections are refused', async () => {
    const url = await unavailableUrl();
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
    await assert.rejects(fetch(`${url}/profile`));
  });
});
