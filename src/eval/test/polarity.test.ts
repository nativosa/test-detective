import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { clauseBoundaries, evaluatePolarity, POLARITY_LIMITS } from '../polarity.ts';
import type { Polarity, PolarityReason, PolarityResult } from '../polarity.ts';
import { listScenarioIds } from '../scenarios.ts';
import { loadGroundTruth } from '../truth.ts';
import type { GroundTruth } from '../truth.ts';

// R3a: the polarity evaluator against the REAL forbidden patterns of the truth
// files (truth-level lookbehind guards included, unchanged). Unit level only: the scorer integration is
// covered by score-regression.test.ts. `conservative` rows are known false positives kept reviewable on purpose;
// `limitation` rows are cases the evaluator cannot fix because the truth regex itself suppresses
// the match.

type Item = { scenario: string; kind: 'claim' | 'rec'; id: string };
type Expected = { text: string; polarity: Polarity; reason?: PolarityReason; via?: 'full_text' | 'clause_suffix' };
type Row = { case: string; item: Item; input: string; expect: Expected[]; why: string; conservative?: string; limitation?: string };

const truths = new Map<string, GroundTruth>();
before(async () => {
  for (const id of await listScenarioIds()) truths.set(id, await loadGroundTruth(id));
});

function patternOf({ scenario, kind, id }: Item): string {
  const t = truths.get(scenario);
  assert.ok(t, `no truth for ${scenario}`);
  const list = kind === 'claim' ? t.rootCause.forbiddenClaims : t.recommendations.forbidden;
  const item = list.find((f) => f.id === id);
  assert.ok(item, `${scenario} has no forbidden ${kind} "${id}"`);
  return item.pattern;
}

const claim = (scenario: string, id: string): Item => ({ scenario, kind: 'claim', id });
const rec = (scenario: string, id: string): Item => ({ scenario, kind: 'rec', id });
const pos = (text: string, reason?: PolarityReason, via?: Expected['via']): Expected => ({ text, polarity: 'positive', ...(reason ? { reason } : {}), ...(via ? { via } : {}) });
const neg = (text: string, reason?: PolarityReason): Expected => ({ text, polarity: 'negated', ...(reason ? { reason } : {}) });
const amb = (text: string, reason?: PolarityReason): Expected => ({ text, polarity: 'ambiguous', ...(reason ? { reason } : {}) });

/** Structural invariants every result must keep, whatever the input. */
function assertWellFormed(input: string, r: PolarityResult) {
  let last = -1;
  const keys = new Set<string>();
  for (const m of r.matches) {
    assert.equal(input.slice(m.start, m.end), m.text, 'offsets point at the matched text');
    assert.ok(m.end > m.start, 'no zero-length match');
    assert.ok(m.clause.start <= m.start && m.end <= m.clause.end, 'the clause contains the match');
    assert.ok(m.start >= last, 'sorted by offset');
    last = m.start;
    const key = `${m.start}:${m.end}`;
    assert.ok(!keys.has(key), `duplicate match ${key}`);
    keys.add(key);
  }
}

// ---------------------------------------------------------------------------
// Matrix (R3a plan rows 1–29, then the step-1 additions)

const ROWS: Row[] = [
  // 1–3: S13-E10 and its neighbours
  {
    case: '1 S13-E10',
    item: rec('S13', 'more-time'),
    input: 'Fix the report endpoint. Do not change anything else and increase the timeout.',
    expect: [pos('increase the timeout', 'no_negation', 'clause_suffix')],
    why: '"and" starts a new imperative clause; the truth lookbehind hid the match on the whole text, the clause suffix recovers it',
  },
  { case: '2', item: rec('S13', 'more-time'), input: 'Do not increase the timeout.', expect: [], why: 'advising against; the S13 guard suppresses it (unchanged)' },
  { case: '3a', item: rec('S13', 'change-locator'), input: 'Do not increase the timeout; change the locator instead.', expect: [pos('change the locator')], why: 'two clauses with opposite polarity' },
  { case: '3b', item: rec('S13', 'more-time'), input: 'Do not increase the timeout; change the locator instead.', expect: [], why: 'the timeout clause is negated (guard)' },
  // 4–12: the R1 false positives
  { case: '4a S11-E3', item: rec('S11', 'more-time'), input: 'Do not increase the timeout; hover over the photo first.', expect: [neg('increase the timeout', 'negator_before')], why: 'advising against a bad fix' },
  { case: '4b S14-E3', item: rec('S14', 'more-time'), input: 'Do not increase the timeout; use a locator instead.', expect: [neg('increase the timeout', 'negator_before')], why: 'advising against a bad fix' },
  { case: '5a S11-E5', item: rec('S11', 'force'), input: 'Do not use force: true or dispatchEvent; hover over the photo first.', expect: [neg('force: true')], why: '"force: true" is a literal, not a clause break' },
  { case: '5b S11-E5', item: rec('S11', 'dispatch'), input: 'Do not use force: true or dispatchEvent; hover over the photo first.', expect: [neg('dispatchEvent')], why: 'the negation distributes over "or"' },
  { case: '6 S14-E6', item: rec('S14', 'sleep'), input: 'No sleep is needed; re-query the checkbox after the reset.', expect: [neg('sleep', 'negator_before')], why: '"No sleep is necessary"' },
  { case: '7 S11-E4', item: claim('S11', 'timing'), input: 'This is not a race condition: the link exists but is hidden until the photo is hovered.', expect: [neg('race condition')], why: 'denying a defect' },
  { case: '8 S14-E4', item: claim('S14', 'timing'), input: 'There was no race or timing problem: the reset replaced the checkbox, and the old handle is detached.', expect: [neg('timing problem')], why: '"no" distributes over "race or timing problem"' },
  { case: '9a S13-E6', item: claim('S13', 'timing'), input: 'It is neither a slow server nor a race condition.', expect: [neg('slow server'), neg('race condition')], why: 'neither … nor' },
  {
    case: '9b',
    item: claim('S13', 'timing'),
    input: 'Neither a race nor a timeout explains the failure.',
    expect: [],
    why: 'no S13 timing pattern matches bare "race" or "timeout"; nothing to judge',
  },
  { case: '9c', item: rec('S13', 'more-time'), input: 'Neither a race condition nor a longer timeout explains the failure.', expect: [neg('longer timeout')], why: '"nor" is not in the S13 guard, so the evaluator decides' },
  { case: '10 S13-E7', item: rec('S13', 'sleep'), input: 'Do not mock the endpoint or add a sleep; fix the report service.', expect: [neg('sleep')], why: 'six words from the negator, same clause, "or"-coordinated' },
  { case: '10b', item: rec('S13', 'mock-it'), input: 'Do not mock the endpoint or add a sleep; fix the report service.', expect: [], why: 'the S13 guard suppresses "mock the endpoint" (unchanged)' },
  { case: '11 S14-E5', item: claim('S14', 'timing'), input: 'A race condition is not the cause: the reset replaced the checkbox and the old handle is detached.', expect: [neg('race condition', 'negated_predicate_after')], why: 'negation after the phrase' },
  { case: '12a S13-E8', item: rec('S13', 'more-time'), input: 'A longer timeout is not the answer; fix the report endpoint.', expect: [neg('longer timeout', 'negated_predicate_after')], why: 'negation after the phrase' },
  { case: '12b S13-E9', item: rec('S13', 'download-permissions'), input: 'Fix the report endpoint; acceptDownloads is not the issue.', expect: [neg('acceptDownloads', 'negated_predicate_after')], why: 'negation after the phrase' },
  // 13–25: counterexamples for simpler rules
  { case: '13', item: claim('S14', 'timing'), input: 'It is a race condition, not a stale handle.', expect: [pos('race condition')], why: 'contrast: the claim is asserted; "negator anywhere in the sentence" would wrongly suppress it' },
  { case: '14', item: claim('S14', 'timing'), input: 'Not a timing issue but a race condition.', expect: [pos('race condition')], why: '"but" boundary; a word-distance window would reach "Not"' },
  { case: '15', item: rec('S13', 'more-time'), input: 'Increase the timeout if the server is not responding.', expect: [pos('Increase the timeout')], why: 'the later negation belongs to the condition, not the recommendation' },
  { case: '16', item: rec('S13', 'more-time'), input: 'Increase the timeout so the test does not fail.', expect: [pos('Increase the timeout')], why: '"so" boundary' },
  { case: '17', item: rec('S13', 'more-time'), input: 'Do not just fix the endpoint; also increase the timeout.', expect: [pos('increase the timeout')], why: 'positive second clause' },
  { case: '18', item: rec('S14', 'retries'), input: "Don't forget to add retries.", expect: [pos('add retries', 'affirming_negation')], why: '"don\'t forget to" recommends' },
  { case: '19', item: claim('S14', 'timing'), input: "We can't rule out a race condition.", expect: [amb('race condition', 'hedge')], why: 'a hedge, not a denial' },
  { case: '20', item: rec('S14', 'sleep'), input: 'Do not add a sleep, but increase the timeout.', expect: [neg('sleep')], why: 'multi-clause: the sleep is advised against' },
  { case: '20b', item: rec('S14', 'more-time'), input: 'Do not add a sleep, but increase the timeout.', expect: [pos('increase the timeout')], why: 'multi-clause: the timeout is recommended' },
  {
    case: '21',
    item: rec('S13', 'more-time'),
    input: 'Another report suggested "increase the timeout"; that would hide the defect.',
    expect: [amb('increase the timeout', 'quoted_or_reported')],
    why: 'quoting without endorsing cannot be told from endorsing deterministically; a person decides',
  },
  { case: '22a', item: rec('S13', 'more-time'), input: 'Do not follow the advice to increase the timeout.', expect: [], why: 'S13 guard (4 words) suppresses it' },
  { case: '22b', item: rec('S14', 'more-time'), input: 'Do not follow the advice to increase the timeout.', expect: [neg('increase the timeout')], why: 'advising against a mentioned fix' },
  { case: '23', item: rec('S14', 'sleep'), input: 'If the reset is slow, add a sleep.', expect: [pos('sleep')], why: 'a conditional recommendation is still a recommendation' },
  { case: '24', item: rec('S11', 'force'), input: 'Never pass { force: true }; hover first.', expect: [neg('force: true')], why: 'code in braces stays one clause' },
  { case: '25', item: rec('S11', 'force'), input: 'Hover first and pass { force: true }.', expect: [pos('force: true')], why: '"and" boundary' },
  // 26–29: unchanged by the truth patterns themselves
  { case: '26a', item: claim('S14', 'checkbox-missing'), input: 'The element is not missing; the stored handle is detached.', expect: [], why: 'no pattern match' },
  { case: '26b', item: claim('S11', 'link-missing'), input: 'The element is not missing; the stored handle is detached.', expect: [], why: 'no pattern match' },
  { case: '27', item: claim('S14', 'app-broken'), input: 'This is not an application defect.', expect: [], why: 'S14 guard suppresses it' },
  { case: '28', item: claim('S13', 'claims-mock'), input: 'The report was not mocked by the test.', expect: [], why: 'S13 guard suppresses it' },
  {
    case: '29a',
    item: rec('S13', 'more-time'),
    input: 'Do not forget to increase the timeout.',
    expect: [],
    why: 'the S13 lookbehind sees "not forget to" in the same clause, so no candidate exists',
    limitation: 'false negative caused by the truth regex; only a truth revision (not R3a) can fix it',
  },
  { case: '29b', item: rec('S14', 'more-time'), input: 'Do not forget to increase the timeout.', expect: [pos('increase the timeout', 'affirming_negation')], why: 'without a truth guard the evaluator reads it as a recommendation' },

  // Step-1 additions
  { case: 'A1', item: claim('S14', 'timing'), input: 'There is no evidence against a race condition.', expect: [amb('race condition', 'reversed_negation')], why: '"no evidence against" leans toward the claim' },
  { case: 'A2a', item: rec('S14', 'retries'), input: 'Do not add retries or increase the timeout.', expect: [neg('add retries')], why: 'advising against' },
  { case: 'A2b', item: rec('S14', 'more-time'), input: 'Do not add retries or increase the timeout.', expect: [neg('increase the timeout')], why: 'the negation distributes over "or"' },
  { case: 'A2c', item: rec('S13', 'more-time'), input: 'Do not add retries or increase the timeout.', expect: [], why: 'S13 guard (3 words) suppresses it' },
  { case: 'A3a', item: rec('S14', 'retries'), input: 'Do not add retries, sleeps or longer timeouts.', expect: [neg('add retries')], why: 'advising against' },
  {
    case: 'A3b',
    item: rec('S14', 'more-time'),
    input: 'Do not add retries, sleeps or longer timeouts.',
    expect: [pos('longer timeout')],
    why: 'the comma ends the negated clause',
    conservative: 'a negated list split by commas: reviewable although it advises against all three',
  },
  { case: 'A4a', item: rec('S14', 'retries'), input: 'Do not add retries, but increase the timeout.', expect: [neg('add retries')], why: 'first clause negated' },
  { case: 'A4b', item: rec('S14', 'more-time'), input: 'Do not add retries, but increase the timeout.', expect: [pos('increase the timeout')], why: 'second clause recommends' },
  { case: 'A4c', item: rec('S13', 'more-time'), input: 'Do not add retries, but increase the timeout.', expect: [pos('increase the timeout', 'no_negation', 'full_text')], why: 'the comma already blocks the S13 guard' },
  { case: 'A5', item: rec('S13', 'sleep'), input: 'Do not add a sleep, but increase the timeout.', expect: [], why: 'S13 guard suppresses the sleep' },
  { case: 'A6', item: rec('S11', 'force'), input: 'Do not use force: true.', expect: [neg('force: true')], why: 'colon before a literal is not a boundary' },
  {
    case: 'A7a',
    item: rec('S14', 'more-time'),
    input: 'Another report suggested increasing the timeout, but that recommendation is wrong.',
    expect: [],
    why: 'the gerund "increasing" matches no more-time pattern (a paraphrase gap, not polarity)',
  },
  {
    case: 'A7b',
    item: rec('S14', 'more-time'),
    input: 'Another report suggested to increase the timeout, but that recommendation is wrong.',
    expect: [amb('increase the timeout', 'quoted_or_reported')],
    why: 'reported advice; the rejection is in another clause',
    conservative: 'rejected in the next clause, still reviewable',
  },
  {
    case: 'A8 paragraph',
    item: rec('S14', 'more-time'),
    input: 'Do not add a sleep. Use a locator instead, and increase the timeout. A longer timeout is not the answer either; never pass { force: true }.',
    expect: [pos('increase the timeout'), neg('longer timeout', 'negated_predicate_after')],
    why: 'two matches of one item with different polarity, judged independently',
  },
  {
    case: 'A8 paragraph (sleep)',
    item: rec('S14', 'sleep'),
    input: 'Do not add a sleep. Use a locator instead, and increase the timeout. A longer timeout is not the answer either; never pass { force: true }.',
    expect: [neg('sleep')],
    why: 'same paragraph, another item',
  },
  {
    case: 'A8 paragraph (force)',
    item: rec('S14', 'force'),
    input: 'Do not add a sleep. Use a locator instead, and increase the timeout. A longer timeout is not the answer either; never pass { force: true }.',
    expect: [neg('force: true')],
    why: 'same paragraph, another item',
  },
  { case: 'A9a', item: rec('S14', 'sleep'), input: 'The reset did not fail. Add a sleep before check().', expect: [pos('sleep')], why: 'the negation is in the previous sentence' },
  { case: 'A9b', item: rec('S14', 'sleep'), input: 'Nothing is broken; add a sleep.', expect: [pos('sleep')], why: 'the negation is in the previous clause' },
  {
    case: 'A10 code',
    item: rec('S14', 'sleep'),
    input: 'Do not add page.waitForTimeout(500) or call setTimeout(() => {}, 500).',
    expect: [neg('waitForTimeout'), neg('setTimeout')],
    why: 'the "." in page.waitForTimeout and the ", " inside parentheses are not clause breaks',
  },
  {
    case: 'A10 URL',
    item: rec('S14', 'sleep'),
    input: 'Never use waitForTimeout (see https://playwright.dev/docs/api/class-page#page-wait-for-timeout, v1.64.1) in tests/ui/settings.spec.ts:10.',
    expect: [neg('waitForTimeout')],
    why: 'URL, version and file:line punctuation does not split the clause',
  },
  {
    case: 'A10 backticks',
    item: rec('S14', 'sleep'),
    input: 'Never add `await page.waitForTimeout(500); await checkbox.check()` to the test.',
    expect: [neg('waitForTimeout')],
    why: 'the "; " inside backtick code is not a boundary',
  },
  {
    case: 'A11',
    item: rec('S14', 'sleep'),
    input: 'Avoid waitForTimeout and setTimeout.',
    expect: [neg('waitForTimeout'), pos('setTimeout')],
    why: '"and" is always a boundary',
    conservative: '"and"-coordinated objects of one negation: the second stays reviewable',
  },
  { case: 'A12', item: claim('S14', 'timing'), input: 'There is no doubt it is a race condition.', expect: [pos('race condition', 'affirming_negation')], why: '"no doubt" affirms' },
  {
    case: 'A13',
    item: rec('S14', 'more-time'),
    input: 'If the endpoint is not fixed increase the timeout.',
    expect: [amb('increase the timeout', 'subordinate_negation')],
    why: 'without a comma the condition and the recommendation share a clause; the negation belongs to the condition',
  },
  { case: 'A14', item: rec('S14', 'sleep'), input: 'Use a locator rather than a sleep.', expect: [neg('sleep', 'negator_before')], why: '"rather than" rejects the sleep' },
  { case: 'A15', item: rec('S14', 'more-time'), input: 'Increase the timeout, which is not ideal.', expect: [pos('Increase the timeout')], why: 'a negated comment after a comma does not negate the recommendation' },
  { case: 'A16', item: rec('S14', 'more-time'), input: 'A longer timeout won’t help.', expect: [neg('longer timeout', 'negated_predicate_after')], why: 'typographic apostrophe' },
  {
    case: 'A17',
    item: claim('S14', 'timing'),
    input: 'It is not true that a race condition is not the cause.',
    expect: [amb('race condition', 'double_negation')],
    why: 'negation on both sides',
  },
  { case: 'A18', item: rec('S11', 'more-time'), input: 'Note: increase the expect timeout.', expect: [pos('increase the expect timeout')], why: 'a colon before words is a boundary' },
];

describe('polarity evaluator: matrix against the real truth patterns', () => {
  for (const row of ROWS) {
    const tags = [row.conservative ? `CONSERVATIVE: ${row.conservative}` : '', row.limitation ? `KNOWN LIMITATION: ${row.limitation}` : ''].filter(Boolean).join('; ');
    test(`${row.case} ${row.item.scenario} ${row.item.id}: ${row.input}${tags ? ` — ${tags}` : ''}`, () => {
      const r = evaluatePolarity(patternOf(row.item), row.input);
      assertWellFormed(row.input, r);
      assert.deepEqual(r.truncated, []);
      const got = r.matches.map((m) => ({ text: m.text, polarity: m.polarity, reason: m.reason, via: m.via }));
      const why = `${row.why}\n${JSON.stringify(r.matches, null, 1)}`;
      assert.equal(got.length, row.expect.length, why);
      for (const [i, e] of row.expect.entries()) {
        assert.equal(got[i]!.text, e.text, why);
        assert.equal(got[i]!.polarity, e.polarity, why);
        if (e.reason) assert.equal(got[i]!.reason, e.reason, why);
        if (e.via) assert.equal(got[i]!.via, e.via, why);
      }
    });
  }
});

describe('polarity evaluator: candidate recovery', () => {
  test('S13-E10: invisible to the truth regex on the whole text, recovered from the clause suffix with the right offsets', () => {
    const pattern = patternOf(rec('S13', 'more-time'));
    const input = 'Fix the report endpoint. Do not change anything else and increase the timeout.';
    assert.equal(new RegExp(pattern, 'i').test(input), false, 'the unchanged truth regex alone finds nothing (v8 behavior)');
    const [m] = evaluatePolarity(pattern, input).matches;
    assert.equal(m?.via, 'clause_suffix');
    assert.equal(m?.start, input.indexOf('increase the timeout'));
    assert.equal(m?.clause.excerpt, 'increase the timeout.');
  });

  test('a match found on the whole text and from a clause start is kept once, as full_text', () => {
    const r = evaluatePolarity(patternOf(rec('S14', 'more-time')), 'Fix it, and increase the timeout.');
    assert.deepEqual(r.matches.map((m) => [m.text, m.via]), [['increase the timeout', 'full_text']]);
  });

  test('a same-clause negation still suppresses through the truth lookbehind (guards are not bypassed)', () => {
    for (const input of ['Do not increase the timeout.', 'Do not forget to increase the timeout.', 'Never increase the test timeout.']) {
      assert.deepEqual(evaluatePolarity(patternOf(rec('S13', 'more-time')), input).matches, [], input);
    }
  });

  test('no forbidden pattern in S01–S14 uses a start or end anchor, which clause-suffix matching would change', () => {
    for (const [id, t] of truths) {
      for (const f of [...t.rootCause.forbiddenClaims, ...t.recommendations.forbidden]) {
        const bare = f.pattern.replace(/\\./g, '').replace(/\[[^\]]*\]/g, '');
        assert.doesNotMatch(bare, /[\^$]/, `${id} ${f.id}`);
      }
    }
  });
});

describe('polarity evaluator: clause boundaries', () => {
  const clauses = (text: string) => {
    const out: string[] = [];
    let at = 0;
    for (const b of clauseBoundaries(text)) {
      out.push(text.slice(at, b.start));
      at = b.end;
    }
    return [...out, text.slice(at)];
  };

  test('code, URLs, paths, versions and literals stay inside one clause', () => {
    assert.deepEqual(clauses('Do not use force: true or dispatchEvent; hover first.'), ['Do not use force: true or dispatchEvent', 'hover first.']);
    assert.deepEqual(clauses("Call page.getByRole('checkbox', { name: 'Email notifications' }).check() after the reset."), [
      "Call page.getByRole('checkbox', { name: 'Email notifications' }).check() after the reset.",
    ]);
    assert.deepEqual(clauses('See https://playwright.dev/docs/api/class-page#page-wait-for-timeout and tests/ui/team.spec.ts:7:32 for details.'), [
      'See https://playwright.dev/docs/api/class-page#page-wait-for-timeout',
      'tests/ui/team.spec.ts:7:32 for details.',
    ]);
    assert.deepEqual(clauses('Playwright 1.64.1 got 503 from /reports/monthly.csv. Retry later.'), ['Playwright 1.64.1 got 503 from /reports/monthly.csv', 'Retry later.']);
    assert.deepEqual(clauses('Set retries: 2 and { timeout: 30_000 }, then rerun.'), ['Set retries: 2', '{ timeout: 30_000 }', 'rerun.']);
    assert.deepEqual(clauses('Use `page.waitForTimeout(1000); await x` sparingly.'), ['Use `page.waitForTimeout(1000); await x` sparingly.']);
  });

  test('prose separators split, "or" and "nor" do not, and unmatched brackets shield nothing', () => {
    assert.deepEqual(clauses('Note: add a sleep.'), ['Note', 'add a sleep.']);
    assert.deepEqual(clauses('Do not mock the endpoint or add a sleep; fix it.'), ['Do not mock the endpoint or add a sleep', 'fix it.']);
    assert.deepEqual(clauses('Unbalanced (paren, and a sleep.'), ['Unbalanced (paren', 'a sleep.']);
    assert.deepEqual(clauses('It failed, but the test is correct, so fix the server.'), ['It failed', 'the test is correct', 'fix the server.']);
  });
});

describe('polarity evaluator: determinism and bounds', () => {
  test('a RegExp argument is neither mutated nor read for lastIndex, and repeated calls agree', () => {
    const re = /increase (the )?(\w+ )?timeout/gi;
    re.lastIndex = 7;
    const input = 'Increase the timeout. Do not increase the timeout.';
    const a = evaluatePolarity(re, input);
    const b = evaluatePolarity(re, input);
    assert.equal(re.lastIndex, 7);
    assert.deepEqual(a, b);
    assert.deepEqual(a, evaluatePolarity(re.source, input));
    assert.deepEqual(a.matches.map((m) => m.polarity), ['positive', 'negated']);
  });

  test('zero-length patterns terminate and match nothing', () => {
    assert.deepEqual(evaluatePolarity('\\b', 'Do not add a sleep.').matches, []);
    assert.deepEqual(evaluatePolarity('(?:)', 'x, y and z.').matches, []);
  });

  test('long text: matches are capped and the result says it was truncated', () => {
    const input = 'Do not add a sleep. '.repeat(5000).trim();
    const r = evaluatePolarity(patternOf(rec('S14', 'sleep')), input);
    assert.equal(r.matches.length, POLARITY_LIMITS.maxMatches);
    assert.ok(r.truncated.includes('max_matches'));
    assert.ok(r.matches.every((m) => m.polarity === 'negated'));
    assertWellFormed(input, r);
  });

  test('clause limit: suffix passes stop, so a recoverable match can be missed and the result says so', () => {
    const input = `${'Fix it. '.repeat(5)}Do not change anything else and increase the timeout.`;
    const r = evaluatePolarity(patternOf(rec('S13', 'more-time')), input, { ...POLARITY_LIMITS, maxClauses: 3 });
    assert.deepEqual(r.matches, []);
    assert.deepEqual(r.truncated, ['max_clauses']);
  });

  test('an over-long clause is not judged negated, and excerpts are cut', () => {
    const input = `Do not ${'really '.repeat(100)}add a sleep.`;
    const [m] = evaluatePolarity(patternOf(rec('S14', 'sleep')), input).matches;
    assert.deepEqual([m?.polarity, m?.reason], ['ambiguous', 'clause_too_long']);
    assert.ok(m!.clause.excerpt.length <= POLARITY_LIMITS.maxExcerpt);
  });
});
