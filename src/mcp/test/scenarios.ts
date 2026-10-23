import { call, consoleMessage, ORIGIN, pageEvent, pageTrace, resource, T0, testTrace, traceZip } from './traces.ts';
import type { Step } from './traces.ts';

// Shared synthetic scenario traces: the stored S04/S05 shapes and route.fetch() variants. Used by
// the MCP trace tests and by the agent tests that need real get_trace_summary output.

export const navigate: Step = { title: 'Navigate', start: T0 + 160, end: T0 + 300, line: 4 };
export const failingExpect: Step = { title: 'Expect "toBeVisible"', method: 'expect', start: T0 + 340, end: T0 + 10370, line: 7, error: true };
export const gotoCall = call('Frame', 'goto', T0 + 165, T0 + 290, { params: { url: '/profile' } });
export const failingExpectCall = call('Frame', 'expect', T0 + 345, T0 + 10365, { error: true, params: { selector: 'internal:text="Dana Demo"i' } });
export const profileDoc = resource({ url: `${ORIGIN}/profile`, type: 'document', start: T0 + 170, serverIP: true });

/** S04: the application's own HTTP 500 on /api/profile. */
export function s04(): Buffer {
  return pageTrace(
    [navigate, failingExpect],
    [...gotoCall, consoleMessage('error', 'Failed to load resource: the server responded with a status of 500 (Internal Server Error)', T0 + 215), ...failingExpectCall],
    [profileDoc, resource({ url: `${ORIGIN}/api/profile`, status: 500, start: T0 + 200, time: 1, serverIP: true })],
  );
}

/** S05: the test fulfills /api/profile with a 500 it created itself. */
export function s05(): Buffer {
  return pageTrace(
    [{ title: 'Route requests', start: T0 + 140, end: T0 + 150, line: 4 }, navigate, { title: 'Fulfill request', start: T0 + 204, end: T0 + 207, line: 5 }, failingExpect],
    [
      ...call('Page', 'setNetworkInterceptionPatterns', T0 + 142, T0 + 149, { title: 'Route requests', params: { patterns: [{ glob: '**/api/profile' }] } }),
      ...gotoCall,
      ...call('Route', 'fulfill', T0 + 205, T0 + 206, { params: { status: 500, headers: [{ name: 'content-type', value: 'application/json' }], body: '{"error":"CANARY_FULFILL_BODY"}', isBase64: false } }),
      ...failingExpectCall,
    ],
    [profileDoc, resource({ url: `${ORIGIN}/api/profile`, status: 500, start: T0 + 200, time: 10, fulfilled: true })],
  );
}

/** route.fetch() then route.fulfill(): the API context records the backend call. */
export function fetchTrace(fetched: number, fulfill: Record<string, unknown>, served: number, options: { uid?: string } = {}): Buffer {
  const uid = options.uid ?? 'uid-1';
  return traceZip(testTrace([navigate, failingExpect]), [
    {
      index: 0,
      browser: '',
      start: T0 + 100,
      events: call('APIRequestContext', 'fetch', T0 + 201, T0 + 210, {
        params: { url: `${ORIGIN}/api/profile`, method: 'GET', headers: [{ name: 'authorization', value: 'Bearer CANARY_API_HDR' }] },
        result: { response: { url: `${ORIGIN}/api/profile`, status: fetched, statusText: '', headers: [{ name: 'set-cookie', value: 'CANARY_API_COOKIE' }], fetchUid: 'uid-1', serverAddr: { ipAddress: '127.0.0.1', port: 4100 } } },
      }),
      network: [resource({ url: `${ORIGIN}/api/profile`, status: fetched, start: T0 + 202, page: null, type: null, apiRef: 'request-context@1', serverIP: true })],
    },
    {
      index: 1,
      browser: 'chromium',
      start: T0 + 90,
      events: [
        pageEvent('page@1', T0 + 150),
        ...call('Page', 'setNetworkInterceptionPatterns', T0 + 142, T0 + 149, { params: { patterns: [{ glob: '**/api/profile' }] } }),
        ...gotoCall,
        ...call('Route', 'fulfill', T0 + 212, T0 + 214, { params: { ...fulfill, ...(fulfill.body === undefined ? { fetchResponseUid: uid } : {}) } }),
        ...failingExpectCall,
      ],
      network: [profileDoc, resource({ url: `${ORIGIN}/api/profile`, status: served, start: T0 + 200, time: 20, fulfilled: true })],
    },
  ]);
}

