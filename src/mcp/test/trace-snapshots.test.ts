import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { listFailures, loadReport } from '../report.ts';
import { getTraceSummary, TraceSummaryOutput } from '../trace-summary.ts';

// Optional: real Playwright 1.64.1 traces from the gitignored evaluation snapshots, read in place.
// Skipped when the snapshots are absent; the committed synthetic fixtures are the real coverage.

const snapshotRoot = (id: string) => fileURLToPath(new URL(`../../../evals/snapshots/${id}/files/`, import.meta.url));

async function attempts(id: string) {
  const loaded = await loadReport(snapshotRoot(id));
  const [failure] = listFailures(loaded).failures;
  const out: TraceSummaryOutput[] = [];
  for (let retry = 0; retry < failure!.attempts.count; retry++) out.push(TraceSummaryOutput.parse(await getTraceSummary(loaded, failure!.testId, retry)));
  return out;
}

describe('get_trace_summary on stored evaluation snapshots (optional)', () => {
  const available = ['S04', 'S05', 'S07', 'S08'].every((id) => existsSync(snapshotRoot(id)));

  test('S04, S05, S07 and S08 read as the synthetic fixtures predict', { skip: available ? false : 'evaluation snapshots not present' }, async () => {
    const [s04] = await attempts('S04');
    const api04 = s04!.network!.requests.find((r) => r.path === '/api/profile')!;
    assert.equal(s04!.trace.status, 'ok');
    assert.deepEqual([api04.status, api04.marker, api04.beforeFailure], [500, 'none', true]);
    assert.equal(s04!.failure?.action, 'Frame.expect');

    const [s05] = await attempts('S05');
    const api05 = s05!.network!.requests.find((r) => r.path === '/api/profile')!;
    assert.deepEqual([api05.status, api05.marker, api05.fulfillment], [500, 'fulfilled', 'f1']);
    assert.deepEqual(s05!.routes?.fulfillments[0]?.fetch, { link: 'none' });
    assert.deepEqual(s05!.routes?.steps.map((s) => s.location), [
      { file: 'tests/ui/profile.spec.ts', line: 4 },
      { file: 'tests/ui/profile.spec.ts', line: 5 },
    ]);

    const [s07r0, s07r1] = await attempts('S07');
    assert.equal(s07r0!.network!.requests.find((r) => r.path === '/api/profile')?.status, 500);
    assert.equal(s07r1!.trace.status, 'missing');

    const [s08] = await attempts('S08');
    assert.equal(s08!.trace.status, 'missing');
  });
});
