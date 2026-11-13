import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { actionKey, clauseBoundaries, collapseWhitespace, endorsement, evaluatePolarity, lineBreaks, POLARITY_LIMITS } from '../polarity.ts';
import type { Polarity, PolarityOptions, PolarityReason, PolarityResult } from '../polarity.ts';
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

// ---------------------------------------------------------------------------
// Caller-declared breaks (R3c step 1). Patterns are the real S13/S14 ones, forbidden and acceptable.

describe('polarity evaluator: caller breaks', () => {
  const acceptable = (scenario: string, id: string) => truths.get(scenario)!.recommendations.acceptable.find((a) => a.id === id)!.anyOf;
  /** Collapses whitespace as the scorer does, keeps the line breaks, and evaluates. */
  const judged = (pattern: string, raw: string) => {
    const { text, breaks } = collapseWhitespace(raw);
    const r = evaluatePolarity(pattern, text, POLARITY_LIMITS, { breaks });
    assertWellFormed(text, r);
    return r.matches.map((m) => [m.text, m.polarity, m.reason]);
  };
  const FIX = () => acceptable('S13', 'fix-server')[0]!;
  const MORE = () => patternOf(rec('S14', 'more-time'));

  test('no breaks, an empty list or an empty options object give exactly the previous result (every matrix row)', () => {
    for (const row of ROWS) {
      const pattern = patternOf(row.item);
      const plain = evaluatePolarity(pattern, row.input);
      assert.deepEqual(evaluatePolarity(pattern, row.input, POLARITY_LIMITS, {}), plain, row.case);
      assert.deepEqual(evaluatePolarity(pattern, row.input, POLARITY_LIMITS, { breaks: [] }), plain, row.case);
      assert.deepEqual(clauseBoundaries(row.input, []), clauseBoundaries(row.input), row.case);
    }
  });

  test('A: an unmarked line break is soft, so the next line neither inherits the negation nor becomes positive', () => {
    const raw = "Don't increase the timeout\nInvestigate the backend";
    assert.deepEqual(collapseWhitespace(raw).breaks.map((b) => b.kind), ['soft']);
    assert.deepEqual(judged(FIX(), raw), [['Investigate the backend', 'ambiguous', 'line_break_scope']]);
    assert.deepEqual(judged(MORE(), raw), [['increase the timeout', 'negated', 'negator_before']]);
    // Without breaks (the scorer today) the negation crosses the line: negated.
    assert.deepEqual(evaluatePolarity(FIX(), raw.replace(/\s+/g, ' ')).matches.map((m) => m.polarity), ['negated']);
  });

  test('B: a wrapped negative instruction is never positive', () => {
    for (const raw of ['Do not\nincrease the timeout.', 'Do not\n\nincrease the timeout.', '- Do not\n- increase the timeout', 'Never\n  increase the timeout']) {
      assert.deepEqual(judged(MORE(), raw), [['increase the timeout', 'ambiguous', 'line_break_scope']], raw);
    }
  });

  test('C: list items of one block are separate instructions (hard), continuation lines included', () => {
    assert.deepEqual(judged(FIX(), "- Don't increase the timeout\n- Investigate the backend"), [['Investigate the backend', 'positive', 'no_negation']]);
    assert.deepEqual(judged(MORE(), "- Don't increase the timeout\n- Investigate the backend"), [['increase the timeout', 'negated', 'negator_before']]);
    assert.deepEqual(judged(FIX(), "1. Don't increase the\n   timeout\n2. Investigate the backend"), [['Investigate the backend', 'positive', 'no_negation']]);
    // The first item needs no earlier item; a plain line before a list item stays soft.
    assert.deepEqual(collapseWhitespace("Don't increase the timeout\n- Investigate the backend").breaks.map((b) => b.kind), ['soft']);
  });

  test('D: line breaks inside code or a call are shielded, so the expression stays one clause', () => {
    const raw = 'Do not use route.fulfill({\n  status: 200,\n  body: "example"\n})';
    const status = acceptable('S05', 'mock-success')[0]!;
    assert.deepEqual(judged(status, raw), [['status: 200', 'negated', 'negator_before']]);
    assert.deepEqual(judged(status, raw.replace('Do not use', 'Use')), [['status: 200', 'positive', 'no_negation']]);
    // Breaks inside a fence are shielded; one before the fence is outside the code and stays a real soft break.
    const sleep = patternOf(rec('S14', 'sleep'));
    assert.deepEqual(judged(sleep, 'Do not apply this: ```\nawait page.waitForTimeout(500)\n```'), [['waitForTimeout', 'negated', 'negator_before']]);
    assert.deepEqual(judged(sleep, 'Do not apply this:\n```\nawait page.waitForTimeout(500)\n```'), [['waitForTimeout', 'ambiguous', 'line_break_scope']]);
  });

  test('E: separate fields (verification steps) are judged one by one, with no breaks needed', () => {
    const rerun = acceptable('S09', 'rerun');
    const polarityOf = (step: string) => rerun.flatMap((p) => evaluatePolarity(p, step).matches.map((m) => m.polarity));
    assert.deepEqual(polarityOf('Do not rerun.'), ['negated']);
    assert.deepEqual(polarityOf('Run the test again.'), ['positive']);
    // Joined without a separator, the second step would inherit the negation.
    assert.deepEqual(polarityOf('Do not rerun the flaky step run the test again'), ['negated', 'negated']);
  });

  test('a soft break never makes a negated match positive; a hard one decides like ". "', () => {
    const raw = 'Do not touch it\nincrease the timeout';
    const { text } = collapseWhitespace(raw);
    const at = { start: text.indexOf(' increase'), end: text.indexOf(' increase') + 1 };
    const one = (kind: 'hard' | 'soft') => evaluatePolarity(MORE(), text, POLARITY_LIMITS, { breaks: [{ ...at, kind }] }).matches.map((m) => [m.polarity, m.reason]);
    assert.deepEqual(evaluatePolarity(MORE(), text).matches.map((m) => [m.polarity, m.reason]), [['negated', 'negator_before']]);
    assert.deepEqual(one('soft'), [['ambiguous', 'line_break_scope']]);
    assert.deepEqual(one('hard'), [['positive', 'no_negation']]);
    // Both kinds on one span: hard wins; repeated spans are kept once.
    assert.deepEqual(evaluatePolarity(MORE(), text, POLARITY_LIMITS, { breaks: [{ ...at, kind: 'soft' }, { ...at, kind: 'hard' }, { ...at, kind: 'soft' }] }).matches.map((m) => m.polarity), ['positive']);
  });

  test('a quote left open before a line break keeps the break soft', () => {
    assert.deepEqual(collapseWhitespace('He wrote "do not\n\nfix the server"').breaks.map((b) => b.kind), ['soft']);
    assert.deepEqual(collapseWhitespace('He wrote "do not mock".\n\nFix the server.').breaks.map((b) => b.kind), ['hard']);
  });

  test('collapseWhitespace keeps the scorer text exactly, and every break points at the space that replaced a line break', () => {
    for (const raw of ["Don't increase the timeout\r\nInvestigate it", '  a\n\n b\tc \n', 'no breaks here', '', '- x\n- y\n\nz']) {
      const { text, breaks } = collapseWhitespace(raw);
      assert.equal(text, raw.replace(/\s+/g, ' '), JSON.stringify(raw));
      assert.equal(breaks.length, lineBreaks(raw).length, JSON.stringify(raw));
      for (const b of breaks) assert.deepEqual([text.slice(b.start, b.end), b.end - b.start], [' ', 1]);
    }
  });

  test('candidate recovery: a soft break adds a clause start, and a match a lookbehind hid there is found but stays ambiguous', () => {
    const pattern = patternOf(rec('S13', 'more-time'));
    const { text, breaks } = collapseWhitespace('Do not touch it\nincrease the timeout');
    assert.equal(new RegExp(pattern, 'i').test(text), false, 'the truth lookbehind hides it on the whole text');
    assert.deepEqual(evaluatePolarity(pattern, text).matches, []);
    const [m] = evaluatePolarity(pattern, text, POLARITY_LIMITS, { breaks }).matches;
    assert.deepEqual([m?.text, m?.via, m?.start, m?.polarity, m?.reason], ['increase the timeout', 'clause_suffix', text.indexOf('increase'), 'ambiguous', 'line_break_scope']);
  });

  test('a match found on the whole text and again from a break-made clause start is kept once', () => {
    const { text, breaks } = collapseWhitespace('- Fix it\n- increase the timeout');
    const r = evaluatePolarity(MORE(), text, POLARITY_LIMITS, { breaks });
    assert.deepEqual(r.matches.map((m) => [m.text, m.via, m.polarity]), [['increase the timeout', 'full_text', 'positive']]);
  });

  test('breaks that coincide with prose separators merge into one boundary', () => {
    const text = 'Fix it. Then wait.';
    const dot = text.indexOf('. ');
    assert.deepEqual(clauseBoundaries(text, [{ start: dot + 1, end: dot + 2 }]), clauseBoundaries(text));
  });

  test('malformed breaks are rejected; more breaks than characters are refused', () => {
    const text = 'Fix it now';
    for (const b of [{ start: -1, end: 1 }, { start: 3, end: 3 }, { start: 5, end: 11 }, { start: 1.5, end: 2 }]) {
      assert.throws(() => evaluatePolarity(MORE(), text, POLARITY_LIMITS, { breaks: [{ ...b, kind: 'soft' }] }), RangeError, JSON.stringify(b));
    }
    assert.throws(() => evaluatePolarity(MORE(), text, POLARITY_LIMITS, { breaks: [{ start: 3, end: 4, kind: 'firm' as 'hard' }] }), RangeError);
    assert.throws(() => evaluatePolarity(MORE(), text, POLARITY_LIMITS, { breaks: Array.from({ length: 11 }, () => ({ start: 3, end: 4, kind: 'soft' as const })) }), RangeError);
  });

  test('limits still apply: soft breaks count toward maxClauses, and truncation is reported', () => {
    const raw = `${'Fix it\n'.repeat(10)}increase the timeout`;
    const { text, breaks } = collapseWhitespace(raw);
    const r = evaluatePolarity(patternOf(rec('S13', 'more-time')), text, { ...POLARITY_LIMITS, maxClauses: 3 }, { breaks });
    assert.ok(r.truncated.includes('max_clauses'));
    const long = collapseWhitespace('Do not add a sleep\n'.repeat(5000));
    const capped = evaluatePolarity(patternOf(rec('S14', 'sleep')), long.text, POLARITY_LIMITS, { breaks: long.breaks });
    assert.equal(capped.matches.length, POLARITY_LIMITS.maxMatches);
    assert.ok(capped.truncated.includes('max_matches'));
  });

  test('repeated calls agree and options are not mutated', () => {
    const { text, breaks } = collapseWhitespace("- Don't mock it\n- add retries: 2");
    const frozen = Object.freeze(breaks.map((b) => Object.freeze({ ...b })));
    const a = evaluatePolarity(patternOf(rec('S14', 'retries')), text, POLARITY_LIMITS, { breaks: frozen });
    assert.deepEqual(a, evaluatePolarity(patternOf(rec('S14', 'retries')), text, POLARITY_LIMITS, { breaks: frozen }));
    assert.deepEqual(a.matches.map((m) => [m.text, m.polarity]), [['add retries', 'positive']]);
  });
});

// ---------------------------------------------------------------------------
// Conflicting polarity (R3c step 1: characterization of the default candidates; step 2A below adds
// clause-local candidates and the endorsement policy)

describe('polarity evaluator: conflicting matches of one acceptable pattern (characterization)', () => {
  const fix = () => truths.get('S13')!.recommendations.acceptable.find((a) => a.id === 'fix-server')!.anyOf[0]!;
  const out = (text: string, pattern = fix()) => evaluatePolarity(pattern, text).matches.map((m) => [m.text, m.via, m.polarity]);

  test('a greedy match can span a retraction: the spanning match is positive, the retracted part negated', () => {
    assert.deepEqual(out("Fix the server. Actually, don't fix the server."), [
      ["Fix the server. Actually, don't fix the server", 'full_text', 'positive'],
      ['fix the server', 'clause_suffix', 'negated'],
    ]);
    assert.deepEqual(out("Fix the server, but don't fix the server."), [
      ["Fix the server, but don't fix the server", 'full_text', 'positive'],
      ['fix the server', 'clause_suffix', 'negated'],
    ]);
  });

  test('a genuine alternative: the negated match spans into the positive one, which the suffix pass recovers', () => {
    assert.deepEqual(out('Do not fix the server; fix the backend.'), [
      ['fix the server; fix the backend', 'full_text', 'negated'],
      ['fix the backend', 'clause_suffix', 'positive'],
    ]);
  });

  test('alternatives in different criteria are judged separately', () => {
    const s14 = truths.get('S14')!.recommendations.acceptable;
    const text = 'Do not use a Locator; instead reacquire the element.';
    const of = (id: string) => s14.find((a) => a.id === id)!.anyOf.flatMap((p) => evaluatePolarity(p, text).matches.map((m) => [m.text, m.polarity]));
    assert.deepEqual(of('use-locator'), [['use a Locator', 'negated']]);
    assert.deepEqual(of('reacquire'), [['reacquire', 'positive']]);
  });
});

// ---------------------------------------------------------------------------
// Clause-local candidates and endorsement (R3c step 2A; no scorer caller yet)

type Span4 = [start: number, end: number, text: string, via: string, polarity: Polarity, reason: PolarityReason];

describe('polarity evaluator: clause-local candidates', () => {
  const crit = (scenario: string, id: string) => truths.get(scenario)!.recommendations.acceptable.find((a) => a.id === id)!.anyOf;
  const CLAUSE: PolarityOptions = { candidates: 'clause' };
  const run = (pattern: string, raw: string) => {
    const { text, breaks } = collapseWhitespace(raw);
    const r = evaluatePolarity(pattern, text, POLARITY_LIMITS, { breaks, candidates: 'clause' });
    assertWellFormed(text, r);
    return r;
  };
  const spans = (r: PolarityResult): Span4[] => r.matches.map((m) => [m.start, m.end, m.text, m.via, m.polarity, m.reason]);
  /** Every pattern of one criterion, as `endorsement` will receive it. */
  const criterion = (scenario: string, id: string, raw: string) => crit(scenario, id).map((p) => run(p, raw));

  test('the default stays exactly as before, and only clause mode marks its result', () => {
    for (const row of ROWS) {
      const pattern = patternOf(row.item);
      const plain = evaluatePolarity(pattern, row.input);
      assert.deepEqual(evaluatePolarity(pattern, row.input, POLARITY_LIMITS, { candidates: 'text' }), plain, row.case);
      assert.equal('candidates' in plain, false, row.case);
      assert.equal(evaluatePolarity(pattern, row.input, POLARITY_LIMITS, CLAUSE).candidates, 'clause', row.case);
    }
    assert.throws(() => evaluatePolarity('x', 'x', POLARITY_LIMITS, { candidates: 'sentence' as 'clause' }), RangeError);
  });

  test('clause mode keeps every default match, and nothing that crosses a boundary is positive (every matrix row)', () => {
    for (const row of ROWS) {
      const pattern = patternOf(row.item);
      const wide = evaluatePolarity(pattern, row.input);
      const local = evaluatePolarity(pattern, row.input, POLARITY_LIMITS, CLAUSE);
      assertWellFormed(row.input, local);
      const keys = new Set(local.matches.map((m) => `${m.start}:${m.end}`));
      for (const m of wide.matches) assert.ok(keys.has(`${m.start}:${m.end}`), `${row.case}: ${m.text} kept`);
      const bounds = clauseBoundaries(row.input);
      for (const m of local.matches) {
        const crosses = bounds.some((b) => b.start < m.end && b.end > m.start);
        assert.equal(m.reason === 'spans_clauses', crosses, `${row.case}: ${m.text}`);
        if (m.polarity === 'positive') assert.ok(!crosses, `${row.case}: positive ${m.text} is inside one clause`);
      }
    }
  });

  test('A and B: a retraction of the same instruction is a conflict, in either form', () => {
    const [fix] = crit('S13', 'fix-server');
    assert.deepEqual(spans(run(fix!, "Fix the server. Actually, don't fix the server.")), [
      [0, 14, 'Fix the server', 'clause_local', 'positive', 'no_negation'],
      [0, 46, "Fix the server. Actually, don't fix the server", 'full_text', 'ambiguous', 'spans_clauses'],
      [32, 46, 'fix the server', 'clause_local', 'negated', 'negator_before'],
    ]);
    assert.deepEqual(spans(run(fix!, "Fix the server, but don't fix the server.")), [
      [0, 14, 'Fix the server', 'clause_local', 'positive', 'no_negation'],
      [0, 40, "Fix the server, but don't fix the server", 'full_text', 'ambiguous', 'spans_clauses'],
      [26, 40, 'fix the server', 'clause_local', 'negated', 'negator_before'],
    ]);
    for (const raw of ["Fix the server. Actually, don't fix the server.", "Fix the server, but don't fix the server.", "Don't fix the server. Fix the server."]) {
      const e = endorsement(criterion('S13', 'fix-server', raw));
      assert.deepEqual([e.verdict, e.contested, e.endorsing], ['conflict', ['fix the server'], []], raw);
    }
  });

  test('C and D: a negated and a positive phrase of one criterion are unresolved, in either order, with the evidence kept', () => {
    const [fix] = crit('S13', 'fix-server');
    assert.deepEqual(spans(run(fix!, 'Fix the backend; do not fix the server.')), [
      [0, 15, 'Fix the backend', 'clause_local', 'positive', 'no_negation'],
      [0, 38, 'Fix the backend; do not fix the server', 'full_text', 'ambiguous', 'spans_clauses'],
      [24, 38, 'fix the server', 'clause_local', 'negated', 'negator_before'],
    ]);
    assert.deepEqual(spans(run(fix!, 'Do not fix the server; fix the backend.')), [
      [7, 21, 'fix the server', 'clause_local', 'negated', 'negator_before'],
      [7, 38, 'fix the server; fix the backend', 'full_text', 'ambiguous', 'spans_clauses'],
      [23, 38, 'fix the backend', 'clause_local', 'positive', 'no_negation'],
    ]);
    for (const [raw, pos, neg] of [['Fix the backend; do not fix the server.', 'Fix the backend', 'fix the server'], ['Do not fix the server; fix the backend.', 'fix the backend', 'fix the server']] as const) {
      const e = endorsement(criterion('S13', 'fix-server', raw));
      assert.deepEqual([e.verdict, e.endorsing, e.contested], ['unresolved', [], ['fix the server']], raw);
      assert.deepEqual(
        [e.evidence.positive.map((m) => m.text), e.evidence.negated.map((m) => m.text), e.evidence.ambiguous, e.evidence.spanning.length],
        [[pos], [neg], [], 1],
        raw,
      );
      assert.equal(e.detail, `endorsed "${pos.toLowerCase()}" beside "fix the server" (negated) in the same criterion: an alternative cannot be told from a contradiction`);
    }
  });

  test('E: alternatives in different criteria are judged separately (S14)', () => {
    const raw = 'Do not use a Locator; instead reacquire the element.';
    assert.deepEqual(criterion('S14', 'use-locator', raw).flatMap(spans), [[7, 20, 'use a Locator', 'clause_local', 'negated', 'negator_before']]);
    assert.deepEqual(criterion('S14', 'reacquire', raw).flatMap(spans), [[30, 39, 'reacquire', 'clause_local', 'positive', 'no_negation']]);
    assert.equal(endorsement(criterion('S14', 'use-locator', raw)).verdict, 'rejected');
    assert.equal(endorsement(criterion('S14', 'reacquire', raw)).verdict, 'endorsed');
    // A conflict in one criterion leaves another criterion's endorsement as it is.
    const both = "Reacquire the element. Use a Locator. Actually, don't use a Locator.";
    assert.equal(endorsement(criterion('S14', 'use-locator', both)).verdict, 'conflict');
    assert.equal(endorsement(criterion('S14', 'reacquire', both)).verdict, 'endorsed');
  });

  test('F: rejected advice that matches no pattern of the criterion does not touch it', () => {
    const raw = 'Fix the server; do not increase the timeout.';
    assert.deepEqual(criterion('S13', 'fix-server', raw).flatMap(spans), [[0, 14, 'Fix the server', 'clause_local', 'positive', 'no_negation']]);
    assert.equal(endorsement(criterion('S13', 'fix-server', raw)).verdict, 'endorsed');
    // A forbidden item sees its own negation, as before (default mode, unchanged; S13's more-time
    // pattern hides this match with its own lookbehind, so S14's is used).
    assert.deepEqual(evaluatePolarity(patternOf(rec('S14', 'more-time')), raw).matches.map((m) => [m.text, m.polarity]), [['increase the timeout', 'negated']]);
  });

  test('G: advice called wrong is a retraction (conflict); advice only discussed stays unresolved', () => {
    const raw = 'Fix the server. The previous suggestion to fix the server was wrong.';
    const [fix] = crit('S13', 'fix-server');
    assert.deepEqual(spans(run(fix!, raw)), [
      [0, 14, 'Fix the server', 'clause_local', 'positive', 'no_negation'],
      [43, 57, 'fix the server', 'clause_local', 'negated', 'rejected_advice'],
    ]);
    const e = endorsement(criterion('S13', 'fix-server', raw));
    assert.deepEqual([e.verdict, e.contested], ['conflict', ['fix the server']]);
    const discussed = endorsement(criterion('S13', 'fix-server', 'Fix the server. The previous suggestion to fix the server was reasonable.'));
    assert.deepEqual([discussed.verdict, discussed.evidence.ambiguous.map((m) => m.reason)], ['unresolved', ['quoted_or_reported']]);
    // The advice rules are clause mode only: the default reading of that clause is unchanged.
    assert.deepEqual(evaluatePolarity(fix!, 'The previous suggestion to fix the server was wrong.').matches.map((m) => m.polarity), ['positive']);
  });

  test('direct advice: the author\'s own recommendation is endorsed, but never over a negation', () => {
    const [fix] = crit('S13', 'fix-server');
    const one = (raw: string) => spans(run(fix!, raw));
    assert.deepEqual(one('I recommend that you fix the server.'), [[21, 35, 'fix the server', 'clause_local', 'positive', 'direct_advice']]);
    assert.deepEqual(one('My recommendation is to fix the server.'), [[24, 38, 'fix the server', 'clause_local', 'positive', 'direct_advice']]);
    assert.deepEqual(one('We suggest you fix the server.'), [[15, 29, 'fix the server', 'clause_local', 'positive', 'direct_advice']]);
    assert.match(run(fix!, 'I recommend that you fix the server.').matches[0]!.detail, /"I recommend that you"/);
    // The rest of the clause still decides: a negation stays a negation.
    assert.deepEqual(one('I recommend that you do not fix the server.'), [[28, 42, 'fix the server', 'clause_local', 'negated', 'negator_before']]);
    assert.deepEqual(one('My recommendation is not to fix the server.'), [[28, 42, 'fix the server', 'clause_local', 'negated', 'negator_before']]);
    // Only the exact first-person forms are masked.
    assert.deepEqual(one('I do not recommend that you fix the server.'), [[28, 42, 'fix the server', 'clause_local', 'ambiguous', 'quoted_or_reported']]);
    assert.deepEqual(one('I suggested to fix the server.'), [[15, 29, 'fix the server', 'clause_local', 'ambiguous', 'quoted_or_reported']]);
    assert.deepEqual(one('He said I recommend that you fix the server.'), [[29, 43, 'fix the server', 'clause_local', 'ambiguous', 'quoted_or_reported']]);
    assert.deepEqual(one('He wrote "I recommend that you fix the server".'), [[31, 45, 'fix the server', 'clause_local', 'ambiguous', 'quoted_or_reported']]);
    for (const raw of ['I recommend that you fix the server.', 'My recommendation is to fix the server.']) assert.equal(endorsement(criterion('S13', 'fix-server', raw)).verdict, 'endorsed', raw);
    // Clause mode only: the default reading stays as it was (REPORTED).
    assert.deepEqual(evaluatePolarity(fix!, 'I recommend that you fix the server.').matches.map((m) => m.reason), ['quoted_or_reported']);
  });

  test('attributed or discussed advice is not endorsed', () => {
    const v = (raw: string) => endorsement(criterion('S13', 'fix-server', raw));
    assert.deepEqual([v('The previous suggestion to fix the server was wrong.').verdict, v('The previous suggestion to fix the server was wrong.').evidence.negated.map((m) => m.reason)], ['rejected', ['rejected_advice']]);
    assert.equal(v('Another engineer suggested fixing the server.').verdict, 'none', 'no pattern matches the gerund');
    assert.equal(v('Another engineer suggested to fix the server.').verdict, 'unresolved');
    assert.deepEqual([v('The recommendation was to fix the server.').verdict, v('The recommendation was to fix the server.').evidence.ambiguous.map((m) => m.reason)], ['unresolved', ['quoted_or_reported']]);
    assert.equal(v('The previous suggestion to fix the server was reasonable.').verdict, 'unresolved');
  });

  test('H: matches of one criterion are never read as independent alternatives', () => {
    const h1 = criterion('S13', 'fix-server', 'Investigate the backend; do not restore the CSV attachment.');
    assert.deepEqual(h1.map(spans), [[[0, 23, 'Investigate the backend', 'clause_local', 'positive', 'no_negation']], [[32, 58, 'restore the CSV attachment', 'clause_local', 'negated', 'negator_before']], []]);
    assert.deepEqual([endorsement(h1).verdict, endorsement(h1).contested], ['unresolved', ['restore the csv attachment']]);
    // The same words through two patterns: both retractions are seen.
    const h2 = criterion('S13', 'fix-server', 'Check the server logs. Do not check the server logs.');
    assert.deepEqual(h2.map(spans), [
      [
        [0, 16, 'Check the server', 'clause_local', 'positive', 'no_negation'],
        [0, 46, 'Check the server logs. Do not check the server', 'full_text', 'ambiguous', 'spans_clauses'],
        [30, 46, 'check the server', 'clause_local', 'negated', 'negator_before'],
      ],
      [],
      [
        [10, 21, 'server logs', 'clause_local', 'positive', 'no_negation'],
        [40, 51, 'server logs', 'clause_local', 'negated', 'negator_before'],
      ],
    ]);
    assert.deepEqual([endorsement(h2).verdict, endorsement(h2).contested], ['conflict', ['check the server', 'server logs']]);
    // A retraction in other words is not taken for an alternative either.
    assert.equal(endorsement(criterion('S13', 'fix-server', 'Restore the CSV attachment. Actually, do not repair the server.')).verdict, 'unresolved');
  });

  test('S13-C12 (R1): the only corrective match is negated, so fix-server is rejected', () => {
    const raw = 'Do not fix the server; add waitForResponse.';
    assert.deepEqual(criterion('S13', 'fix-server', raw).flatMap(spans), [[7, 21, 'fix the server', 'clause_local', 'negated', 'negator_before']]);
    assert.equal(endorsement(criterion('S13', 'fix-server', raw)).verdict, 'rejected');
    assert.equal(endorsement(criterion('S13', 'check-status', raw)).verdict, 'endorsed');
  });

  test('a match reachable only across a boundary is never an endorsement, but a clause-local one beside it is', () => {
    const raw = 'Instead of the ElementHandle, use a locator.';
    assert.deepEqual(criterion('S14', 'use-locator', raw).flatMap(spans), [
      [0, 43, 'Instead of the ElementHandle, use a locator', 'full_text', 'ambiguous', 'spans_clauses'],
      [30, 43, 'use a locator', 'clause_local', 'positive', 'no_negation'],
    ]);
    assert.equal(endorsement(criterion('S14', 'use-locator', raw)).verdict, 'endorsed');
    const only = endorsement(criterion('S13', 'fix-server', 'Fix it; the server is fine.'));
    assert.deepEqual([only.verdict, only.detail], ['unresolved', 'matched only across clause boundaries']);
  });

  test('line breaks: a match across a soft break is not an instruction, and a soft break never proves endorsement', () => {
    const [fix] = crit('S13', 'fix-server');
    assert.deepEqual(spans(run(fix!, 'Fix the\nserver')), [[0, 14, 'Fix the server', 'full_text', 'ambiguous', 'spans_clauses']]);
    assert.match(run(fix!, 'Fix the\nserver').matches[0]!.detail, /a line break of unknown role/);
    assert.equal(endorsement(criterion('S13', 'fix-server', 'Fix the\nserver')).verdict, 'unresolved');
    assert.deepEqual(spans(run(fix!, "Don't increase the timeout\nFix the server")), [[27, 41, 'Fix the server', 'clause_local', 'ambiguous', 'line_break_scope']]);
    assert.equal(endorsement(criterion('S13', 'fix-server', "Don't increase the timeout\nFix the server")).verdict, 'unresolved');
    // List items are hard breaks: the second item is its own instruction.
    assert.deepEqual(spans(run(fix!, "- Don't increase the timeout\n- Fix the server")), [[31, 45, 'Fix the server', 'clause_local', 'positive', 'no_negation']]);
    assert.equal(endorsement(criterion('S13', 'fix-server', "- Fix the server\n- Don't fix the server")).verdict, 'conflict');
  });

  test('shielded code stays one clause', () => {
    const raw = "Use route.fulfill({ status: 200, body: 'ok' }); do not remove the mock.";
    assert.deepEqual(criterion('S05', 'mock-success', raw).flatMap(spans), [
      [20, 31, 'status: 200', 'clause_local', 'positive', 'no_negation'],
    ]);
    assert.deepEqual(criterion('S05', 'remove-mock', raw).flatMap(spans), [[55, 70, 'remove the mock', 'clause_local', 'negated', 'negator_before']]);
    assert.deepEqual(criterion('S09', 'rerun', 'Run `npx playwright test; echo done` once.').flatMap(spans), [[5, 24, 'npx playwright test', 'clause_local', 'positive', 'no_negation']]);
  });

  test('endorsement policy: repetition, mention, ambiguity, rejection and no match', () => {
    const e = (raw: string) => endorsement(criterion('S13', 'fix-server', raw));
    const twice = e('Fix the server. Then fix the server again.');
    assert.deepEqual([twice.verdict, twice.endorsing.map((m) => m.text)], ['endorsed', ['Fix the server', 'fix the server']]);
    assert.deepEqual([e('Fix the server. Someone suggested to fix the server.').verdict, e('Fix the server. Someone suggested to fix the server.').contested], ['unresolved', ['fix the server']]);
    assert.deepEqual([e('Fix the backend. Someone suggested to fix the server.').verdict], ['unresolved']);
    assert.deepEqual([e('Someone suggested to fix the server.').verdict, e('Someone suggested to fix the server.').detail], ['unresolved', 'only ambiguous matches']);
    assert.deepEqual([e('Do not fix the server. Never fix the backend.').verdict], ['rejected']);
    assert.deepEqual([e('Add waitForResponse.').verdict], ['none']);
    assert.equal(actionKey(' `Fix  the Server.` '), 'fix the server');
  });

  test('without a regex match there is nothing to endorse (the v10 gate keeps deciding)', () => {
    for (const id of truths.keys()) {
      for (const a of truths.get(id)!.recommendations.acceptable) {
        for (const raw of ['Fix the server; do not mock.', 'Investigate further.', 'No change is needed.', 'Use the old handle.']) {
          const gate = a.anyOf.some((p) => new RegExp(p, 'i').test(raw));
          const verdict = endorsement(a.anyOf.map((p) => evaluatePolarity(p, raw, POLARITY_LIMITS, CLAUSE))).verdict;
          if (!gate) assert.equal(verdict, 'none', `${id}/${a.id}: ${raw}`);
        }
      }
    }
  });

  test('limits: clauses and matches stay bounded, and a truncated analysis is never an endorsement', () => {
    const [fix] = crit('S13', 'fix-server');
    const { text, breaks } = collapseWhitespace(`${'- Wait\n'.repeat(10)}- Fix the server`);
    const few = evaluatePolarity(fix!, text, { ...POLARITY_LIMITS, maxClauses: 3 }, { breaks, candidates: 'clause' });
    assert.ok(few.truncated.includes('max_clauses'));
    assert.equal(endorsement([few]).verdict, 'unresolved');
    const many = evaluatePolarity(fix!, 'Fix the server. '.repeat(500), POLARITY_LIMITS, CLAUSE);
    assert.equal(many.matches.length, POLARITY_LIMITS.maxMatches);
    assert.ok(many.truncated.includes('max_matches'));
    assert.deepEqual([endorsement([many]).verdict, endorsement([many]).detail], ['unresolved', 'the analysis was truncated, so a retraction may be unseen']);
  });

  test('endorsement takes clause-mode results only; repeated calls agree and inputs are not mutated', () => {
    assert.throws(() => endorsement([evaluatePolarity(crit('S13', 'fix-server')[0]!, 'Fix the server.')]), TypeError);
    const { text, breaks } = collapseWhitespace("Fix the server.\n\nActually, don't fix the server.");
    const frozen: PolarityOptions = Object.freeze({ candidates: 'clause', breaks: Object.freeze(breaks.map((b) => Object.freeze({ ...b }))) });
    const a = crit('S13', 'fix-server').map((p) => evaluatePolarity(p, text, POLARITY_LIMITS, frozen));
    assert.deepEqual(a, crit('S13', 'fix-server').map((p) => evaluatePolarity(p, text, POLARITY_LIMITS, frozen)));
    assert.deepEqual(endorsement(a), endorsement(Object.freeze([...a])));
    assert.equal(endorsement(a).verdict, 'conflict');
  });
});