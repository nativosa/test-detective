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
//   GET  /help          help page with a link that opens /help/guide in a new window
//   GET  /help/guide    user guide page
//   GET  /team          team page: each member's name and profile link are shown while their photo is hovered
//   GET  /team/<slug>   member profile page (404 for unknown members)
//   GET  /settings      "Email notifications" checkbox; "Reset preferences" replaces it with a new, unchecked one
//   GET  /api/profile   by profileApi mode:
//                         ok          200 JSON (after profileDelayMs, if set)
//                         error       500
//                         fail-first  500 for this server's first request, 200 afterwards
//                         hang        never answers (the connection is dropped on close)

export const PROFILE_API_MODES = ['ok', 'error', 'fail-first', 'hang'] as const;
export const MAX_PROFILE_DELAY_MS = 5_000;
export type AppConfig = { profileApi: (typeof PROFILE_API_MODES)[number]; profileDelayMs?: number };
export type RunningApp = { url: string; close: () => Promise<void> };

export const USER = { username: 'demo', password: 'demo-password', name: 'Dana Demo', email: 'dana@example.test' };

const MAX_BODY_BYTES = 10_000;

export function createApp(config: AppConfig): http.Server {
  const state: AppState = { profileRequests: 0 };
  return http.createServer((req, res) => {
    handle(config, state, req, res).catch(() => {
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

/**
 * A URL on 127.0.0.1 where nothing listens: binds a free port, then releases it, so connecting
 * is refused. Another process could take the port in between; callers verify the refusal.
 */
export async function unavailableUrl(): Promise<string> {
  const app = await startApp({ profileApi: 'ok' });
  await app.close();
  return app.url;
}

/** Per-server state, so each started app (one per generated run) counts its own requests. */
type AppState = { profileRequests: number };

async function handle(config: AppConfig, state: AppState, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
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
  if (route === 'GET /help') return send(res, 200, 'text/html', HELP_PAGE);
  if (route === 'GET /help/guide') return send(res, 200, 'text/html', GUIDE_PAGE);
  if (route === 'GET /team') return send(res, 200, 'text/html', TEAM_PAGE);
  if (req.method === 'GET' && pathname.startsWith('/team/')) {
    const member = TEAM.find((m) => `/team/${m.slug}` === pathname);
    if (member) return send(res, 200, 'text/html', memberPage(member));
  }
  if (route === 'GET /settings') return send(res, 200, 'text/html', SETTINGS_PAGE);
  if (route === 'GET /api/profile') {
    state.profileRequests += 1;
    const failed = config.profileApi === 'error' || (config.profileApi === 'fail-first' && state.profileRequests === 1);
    if (failed) return send(res, 500, 'application/json', JSON.stringify({ error: 'Internal Server Error' }));
    if (config.profileApi === 'hang') return;
    if (config.profileDelayMs) await new Promise((resolve) => setTimeout(resolve, config.profileDelayMs));
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

const HELP_PAGE = layout(
  'Help',
  `<h1>Help</h1>
<p>Step-by-step instructions for using the portal are in the user guide.</p>
<p><a href="/help/guide" target="_blank">Open the user guide</a></p>`,
);

const GUIDE_PAGE = layout(
  'User guide',
  `<h1>User guide</h1>
<p>Sign in with your username and password, then open Profile to see your details.</p>`,
);

export const TEAM = [
  { slug: 'ana-lopez', name: 'Ana Lopez', first: 'Ana', role: 'Engineering lead' },
  { slug: 'ben-carter', name: 'Ben Carter', first: 'Ben', role: 'Product designer' },
  { slug: 'chen-wei', name: 'Chen Wei', first: 'Chen', role: 'Support specialist' },
] as const;
type Member = (typeof TEAM)[number];

// Inline image, so the page makes no extra requests.
const AVATAR = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Crect width='120' height='120' fill='%23c8d0dc'/%3E%3C/svg%3E`;

const TEAM_PAGE = layout(
  'Team',
  `<style>
  .team figure { display: inline-block; margin: 0 1rem 1rem 0; vertical-align: top; }
  .team figcaption { display: none; }
  .team figure:hover figcaption { display: block; }
</style>
<h1>Team</h1>
<p>Hover over a team member's photo to see their name and profile link.</p>
<div class="team">
${TEAM.map(
  (m) => `  <figure>
    <img src="${AVATAR}" alt="${m.name}" width="120" height="120">
    <figcaption>
      <h2>${m.name}</h2>
      <a href="/team/${m.slug}">View ${m.first}'s profile</a>
    </figcaption>
  </figure>`,
).join('\n')}
</div>`,
);

function memberPage(member: Member): string {
  return layout(member.name, `<h1>${member.name}</h1>\n<p>${member.role}</p>\n<p><a href="/team">Back to the team</a></p>`);
}

// Reset builds a new checkbox element instead of re-inserting the old one.
const SETTINGS_PAGE = layout(
  'Settings',
  `<h1>Settings</h1>
<p id="email-setting"><input type="checkbox" id="email-notifications" checked> <label for="email-notifications">Email notifications</label></p>
<p><button type="button" id="reset">Reset preferences</button></p>
<p role="status" id="reset-status"></p>
<script>
  document.getElementById('reset').addEventListener('click', () => {
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = 'email-notifications';
    document.getElementById('email-notifications').replaceWith(checkbox);
    document.getElementById('reset-status').textContent = 'Preferences reset';
  });
</script>`,
);

// Manual use: node evals/app/server.ts [--profile-api ok|error|fail-first|hang] [--profile-delay-ms n] [--port n]
if (import.meta.main) {
  const { values } = parseArgs({
    options: { 'profile-api': { type: 'string', default: 'ok' }, 'profile-delay-ms': { type: 'string', default: '0' }, port: { type: 'string', default: '0' } },
  });
  const mode = values['profile-api'];
  if (!PROFILE_API_MODES.some((m) => m === mode)) {
    console.error(`--profile-api must be one of: ${PROFILE_API_MODES.join(', ')}`);
    process.exit(2);
  }
  const delay = Number(values['profile-delay-ms']);
  const app = await startApp({ profileApi: mode as AppConfig['profileApi'], profileDelayMs: delay }, Number(values.port));
  console.log(`fixture app listening on ${app.url} (profileApi: ${mode}, profileDelayMs: ${delay})`);
  process.on('SIGINT', () => void app.close().then(() => process.exit(0)));
}
