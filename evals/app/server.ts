import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseArgs } from 'node:util';

// Deterministic fixture app for evaluation scenarios. Node built-ins only, bound to 127.0.0.1.
// Fault modes are chosen by whoever starts it (the generator), so nothing about the fault
// appears in the scenario's test or config. Never copied into an investigation workspace.
//
//   GET  /login         login form (Username, Password, "Log in" button)
//   POST /login         valid credentials -> 303 /profile, otherwise 401 with an alert
//   GET  /profile       page that loads /api/profile in the browser
//   GET  /api/profile   200 JSON, or 500 when profileApi is "error"

export const PROFILE_API_MODES = ['ok', 'error'] as const;
export type AppConfig = { profileApi: (typeof PROFILE_API_MODES)[number] };
export type RunningApp = { url: string; close: () => Promise<void> };

export const USER = { username: 'demo', password: 'demo-password', name: 'Dana Demo', email: 'dana@example.test' };

const MAX_BODY_BYTES = 10_000;

export function createApp(config: AppConfig): http.Server {
  return http.createServer((req, res) => {
    handle(config, req, res).catch(() => {
      if (!res.headersSent) send(res, 500, 'text/plain', 'fixture app error');
      else res.destroy();
    });
  });
}

/** Starts the app on 127.0.0.1. Port 0 picks a free port. */
export async function startApp(config: AppConfig, port = 0): Promise<RunningApp> {
  const server = createApp(config);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const { port: actual } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${actual}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function handle(config: AppConfig, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  const route = `${req.method} ${pathname}`;
  if (route === 'GET /') return redirect(res, '/login');
  if (route === 'GET /login') return send(res, 200, 'text/html', loginPage(null));
  if (route === 'POST /login') {
    const form = new URLSearchParams(await readBody(req));
    if (form.get('username') === USER.username && form.get('password') === USER.password) return redirect(res, '/profile');
    return send(res, 401, 'text/html', loginPage('Invalid username or password.'));
  }
  if (route === 'GET /profile') return send(res, 200, 'text/html', PROFILE_PAGE);
  if (route === 'GET /api/profile') {
    if (config.profileApi === 'error') return send(res, 500, 'application/json', JSON.stringify({ error: 'Internal Server Error' }));
    return send(res, 200, 'application/json', JSON.stringify({ name: USER.name, email: USER.email }));
  }
  send(res, 404, 'text/plain', 'Not found');
}

function send(res: http.ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
  res.end(body);
}

function redirect(res: http.ServerResponse, location: string): void {
  res.writeHead(303, { location, 'cache-control': 'no-store' });
  res.end();
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) {
    body += String(chunk);
    if (body.length > MAX_BODY_BYTES) throw new Error('body too large');
  }
  return body;
}

const layout = (title: string, main: string) => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${title} · Acme Portal</title></head>
<body>
<header><strong>Acme Portal</strong></header>
<main>
${main}
</main>
</body>
</html>`;

function loginPage(error: string | null): string {
  return layout(
    'Log in',
    `<h1>Log in</h1>
${error ? `<div role="alert">${error}</div>` : ''}
<form method="post" action="/login">
  <label for="username">Username</label>
  <input id="username" name="username" autocomplete="username">
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="current-password">
  <button type="submit">Log in</button>
</form>`,
  );
}

const PROFILE_PAGE = layout(
  'Profile',
  `<h1>Profile</h1>
<p id="status">Loading your profile…</p>
<div role="alert" id="error" hidden>Something went wrong while loading your profile. Please try again later.</div>
<dl id="details" hidden>
  <dt>Name</dt><dd id="name"></dd>
  <dt>Email</dt><dd id="email"></dd>
</dl>
<script>
  fetch('/api/profile')
    .then((response) => {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    })
    .then((profile) => {
      document.getElementById('name').textContent = profile.name;
      document.getElementById('email').textContent = profile.email;
      document.getElementById('details').hidden = false;
    })
    .catch(() => {
      document.getElementById('error').hidden = false;
    })
    .finally(() => {
      document.getElementById('status').hidden = true;
    });
</script>`,
);

// Manual use: node evals/app/server.ts [--profile-api ok|error] [--port n]
if (import.meta.main) {
  const { values } = parseArgs({ options: { 'profile-api': { type: 'string', default: 'ok' }, port: { type: 'string', default: '0' } } });
  const mode = values['profile-api'];
  if (!PROFILE_API_MODES.some((m) => m === mode)) {
    console.error(`--profile-api must be one of: ${PROFILE_API_MODES.join(', ')}`);
    process.exit(2);
  }
  const app = await startApp({ profileApi: mode as AppConfig['profileApi'] }, Number(values.port));
  console.log(`fixture app listening on ${app.url} (profileApi: ${mode})`);
  process.on('SIGINT', () => void app.close().then(() => process.exit(0)));
}
