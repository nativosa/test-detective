// Polarity of forbidden-pattern matches (R3a; used by score.ts for review-severity forbidden items since v9).
//
// A truth's forbidden pattern says what a bad claim or fix looks like; it does not say whether the
// report asserts it, rejects it, or only mentions it. This module finds every match of a pattern in
// a report text and judges each one inside its own clause:
//   positive  — asserted or recommended ("increase the timeout", "it is a race condition")
//   negated   — clearly denied or advised against ("do not increase the timeout",
//               "a race condition is not the cause")
//   ambiguous — negation is present but its scope or meaning is unclear (subordinate clauses,
//               double negations, quoted or reported advice, over-long clauses)
// Only `negated` may ever be suppressed by a caller; positive and ambiguous stay reviewable.
//
// Deterministic and pure: no I/O, no model, no shared RegExp state. Work and output are bounded
// (POLARITY_LIMITS). The truth patterns, including their own negation lookbehinds, are used as they
// are: matching on clause suffixes can only add matches that a lookbehind suppressed because of a
// negation in an EARLIER clause (S13-E10); a negation in the same clause still suppresses them.
//
// Caller-declared breaks (R3c step 1; no caller yet). A caller may add separators the prose rules
// can't see, such as line breaks. A `hard` break is a clause boundary like ". ". A `soft` break is a
// separator whose role is unknown (a line break may end an instruction or wrap one): each match is
// judged with and without it, and if the two readings differ the match is ambiguous, so a soft break
// can never turn a negated match into a positive one. The caller decides which offsets are safe;
// `lineBreaks` gives a conservative default. Without breaks every result is as before.
//
// Clause-local candidates (R3c step 2A; no caller yet). A pattern such as `fix .{0,40}server` can
// match across clauses ("Fix the server. Actually, don't fix the server"), and the full-text match is
// greedy, so the clause that holds an instruction may have no match of its own. With
// `candidates: 'clause'` the pattern is also run on each clause alone (soft breaks included), and a
// match that crosses any boundary is ambiguous (spans_clauses), whatever its reading: only a match
// inside one clause can be positive. Clause mode also applies three fixed advice word lists (direct
// advice, advice nouns, rejected advice; see judgeLocal). `endorsement` combines such results under the
// conflict policy documented there. The default ('text') returns exactly the results described above.

export type Span = { start: number; end: number };
/** A caller-declared separator: a span of the text passed to evaluatePolarity. */
export type Break = Span & { kind: 'hard' | 'soft' };
export type PolarityOptions = { breaks?: readonly Break[]; candidates?: 'text' | 'clause' };
export type Polarity = 'positive' | 'negated' | 'ambiguous';
export type PolarityReason =
  | 'no_negation'
  | 'negator_before'
  | 'negated_predicate_after'
  | 'affirming_negation'
  | 'hedge'
  | 'subordinate_negation'
  | 'reversed_negation'
  | 'double_negation'
  | 'quoted_or_reported'
  | 'clause_too_long'
  | 'line_break_scope'
  | 'spans_clauses'
  | 'direct_advice'
  | 'rejected_advice';

export type PolarityMatch = {
  /** The matched phrase, exactly text.slice(start, end). */
  text: string;
  start: number;
  end: number;
  /**
   * full_text: the pattern matched the whole text; clause_suffix: only when matched from a clause
   * start; clause_local: matched on one clause alone (candidates: 'clause' only).
   */
  via: 'full_text' | 'clause_suffix' | 'clause_local';
  /** The clause the match was judged in; `excerpt` is cut to POLARITY_LIMITS.maxExcerpt characters. */
  clause: Span & { excerpt: string };
  polarity: Polarity;
  reason: PolarityReason;
  detail: string;
};

export type PolarityResult = {
  matches: PolarityMatch[];
  /** Limits that were hit. A caller must not treat a truncated result as complete (review it). */
  truncated: ('max_matches' | 'max_clauses')[];
  /** Present only for candidates: 'clause'; `endorsement` accepts nothing else. */
  candidates?: 'clause';
};

export type PolarityLimits = {
  /** Distinct matches returned. */
  maxMatches: number;
  /** Clause starts that get a suffix pass. */
  maxClauses: number;
  /** Characters past a clause's end that a suffix pass may still match into. */
  suffixLookahead: number;
  /** Characters of clause text before/after a match that are examined. */
  maxWindow: number;
  /** Characters of clause text kept in the output excerpt. */
  maxExcerpt: number;
};

export const POLARITY_LIMITS: PolarityLimits = { maxMatches: 50, maxClauses: 500, suffixLookahead: 400, maxWindow: 400, maxExcerpt: 300 };

// ---------------------------------------------------------------------------
// Clauses

/**
 * Clause boundaries, as [start, end) spans of the separator text: sentence punctuation followed by
 * whitespace, ", ", ": " (unless it introduces a literal, as in `force: true` or `retries: 2`), and the
 * coordinators and/but/then/so/yet/however/whereas/although/though. "or" and "nor" are NOT
 * boundaries: a negation distributes over them ("do not mock the endpoint or add a sleep").
 * Separators inside backtick code or matched brackets are ignored, so code, URLs, paths and version
 * numbers stay whole. Sorted, overlapping separators merged. `extra` spans (caller breaks, already
 * validated) are added under the same shielding.
 */
export function clauseBoundaries(text: string, extra: readonly Span[] = []): Span[] {
  const shielded = shieldedPositions(text);
  const found: Span[] = [];
  const add = (re: RegExp) => {
    for (const m of text.matchAll(re)) if (!shielded[m.index]) found.push({ start: m.index, end: m.index + m[0].length });
  };
  add(/[.!?;]\s+/g);
  add(/,\s+/g);
  add(/:\s+(?!(?:true|false|null|undefined|-?\d|['"`{[]))/gi);
  add(/\s+(?:and|but|then|so|yet|however|whereas|although|though)\s+/gi);
  for (const s of extra) if (!shielded[s.start]) found.push({ start: s.start, end: s.end });
  found.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Span[] = [];
  for (const s of found) {
    const last = merged.at(-1);
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else merged.push({ ...s });
  }
  return merged;
}

/** Positions inside backtick code or a matched (), [] or {} pair (unmatched brackets shield nothing). */
function shieldedPositions(text: string): Uint8Array {
  const delta = new Int32Array(text.length + 1);
  const shield = (open: number, close: number) => {
    delta[open + 1]! += 1;
    delta[close]! -= 1;
  };
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  const stack: { ch: string; at: number }[] = [];
  let tick = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '`') {
      if (tick < 0) tick = i;
      else {
        shield(tick, i);
        tick = -1;
      }
    } else if (ch === '(' || ch === '[' || ch === '{') stack.push({ ch, at: i });
    else if (ch in pairs) {
      let at = stack.length - 1;
      while (at >= 0 && stack[at]!.ch !== pairs[ch]) at--;
      if (at >= 0) {
        shield(stack[at]!.at, i);
        stack.length = at;
      }
    }
  }
  const out = new Uint8Array(text.length);
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    depth += delta[i]!;
    out[i] = depth > 0 ? 1 : 0;
  }
  return out;
}

/** The clause containing [start, end): between the nearest boundaries outside the match. */
export function clauseOf(text: string, match: Span, boundaries: Span[] = clauseBoundaries(text)): Span {
  let start = 0;
  let end = text.length;
  for (const b of boundaries) {
    if (b.end <= match.start) start = b.end;
    else if (b.start >= match.end) {
      end = b.start;
      break;
    }
  }
  return { start, end };
}

// ---------------------------------------------------------------------------
// Candidates

type Candidate = Span & { text: string; via: PolarityMatch['via'] };

/** A fresh global RegExp, so neither the caller's instance nor its lastIndex is ever touched. */
function compile(pattern: string | RegExp): RegExp {
  if (typeof pattern === 'string') return new RegExp(pattern, 'gi');
  return new RegExp(pattern.source, [...new Set(`${pattern.flags.replace(/[gy]/g, '')}g`)].join(''));
}

/**
 * Every distinct match of `pattern`: on the whole text, then from each clause start (so a
 * lookbehind cannot see a negator in an earlier clause). Sorted by offset; a match found both ways
 * is kept once, as full_text. Zero-length matches are ignored.
 */
export function findCandidates(pattern: string | RegExp, text: string, limits: PolarityLimits = POLARITY_LIMITS, boundaries: Span[] = clauseBoundaries(text)): { candidates: Candidate[]; truncated: PolarityResult['truncated'] } {
  const seen = new Map<string, Candidate>();
  const truncated = new Set<PolarityResult['truncated'][number]>();
  const record = (start: number, value: string, via: Candidate['via']) => {
    const key = `${start}:${start + value.length}`;
    if (seen.has(key)) return true;
    if (seen.size >= limits.maxMatches) {
      truncated.add('max_matches');
      return false;
    }
    seen.set(key, { start, end: start + value.length, text: value, via });
    return true;
  };
  const scan = (from: number, to: number, startsBefore: number, via: Candidate['via']) => {
    const re = compile(pattern);
    const slice = text.slice(from, to);
    for (let m = re.exec(slice); m; m = re.exec(slice)) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      if (m.index >= startsBefore) break;
      if (!record(from + m.index, m[0], via)) break;
    }
  };
  scan(0, text.length, text.length, 'full_text');
  for (const [i, b] of boundaries.entries()) {
    if (i >= limits.maxClauses) {
      truncated.add('max_clauses');
      break;
    }
    const clauseEnd = boundaries[i + 1]?.start ?? text.length;
    scan(b.end, Math.min(text.length, clauseEnd + limits.suffixLookahead), clauseEnd - b.end, 'clause_suffix');
  }
  const candidates = [...seen.values()].sort((a, b) => a.start - b.start || a.end - b.end);
  return { candidates, truncated: [...truncated] };
}

/**
 * Candidates for candidates: 'clause'. The pattern runs on each clause between `boundaries` alone
 * (clause_local), so a match can't reach into the next clause. The findCandidates matches are added
 * too, so none is lost: those that overlap a boundary come back with `spans: true`. The same
 * maxMatches and maxClauses limits apply to the two passes together.
 */
export function findClauseCandidates(pattern: string | RegExp, text: string, limits: PolarityLimits = POLARITY_LIMITS, boundaries: Span[] = clauseBoundaries(text)): { candidates: (Candidate & { spans: boolean })[]; truncated: PolarityResult['truncated'] } {
  const seen = new Map<string, Candidate & { spans: boolean }>();
  const truncated = new Set<PolarityResult['truncated'][number]>();
  const record = (c: Candidate & { spans: boolean }) => {
    const key = `${c.start}:${c.end}`;
    if (seen.has(key)) return true;
    if (seen.size >= limits.maxMatches) {
      truncated.add('max_matches');
      return false;
    }
    seen.set(key, c);
    return true;
  };
  const clauses = boundaries.length + 1;
  for (let i = 0; i < clauses; i++) {
    if (i >= limits.maxClauses) {
      truncated.add('max_clauses');
      break;
    }
    const from = i === 0 ? 0 : boundaries[i - 1]!.end;
    const slice = text.slice(from, boundaries[i]?.start ?? text.length);
    const re = compile(pattern);
    for (let m = re.exec(slice); m; m = re.exec(slice)) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      if (!record({ start: from + m.index, end: from + m.index + m[0].length, text: m[0], via: 'clause_local', spans: false })) break;
    }
  }
  const wide = findCandidates(pattern, text, limits, boundaries);
  for (const t of wide.truncated) truncated.add(t);
  for (const c of wide.candidates) {
    if (!record({ ...c, spans: boundaries.some((b) => b.start < c.end && b.end > c.start) })) break;
  }
  const candidates = [...seen.values()].sort((a, b) => a.start - b.start || a.end - b.end);
  return { candidates, truncated: [...truncated] };
}

// ---------------------------------------------------------------------------
// Polarity

// Module-level patterns are only used with String methods that ignore lastIndex (matchAll clones,
// replace resets) or are non-global, so no call depends on state left by another.
const APOS = "['’]";
const NEGATOR = new RegExp(`\\b(?:not|no|never|nothing|none|neither|nor|without|avoid|avoiding|cannot)\\b|n${APOS}t\\b|\\binstead of\\b|\\brather than\\b`, 'gi');
/** Negations that affirm: "do not forget to", "not only", "no doubt". Removed before looking for a negator. */
const AFFIRMING_SOURCE = `\\b(?:not|never)\\s+(?:only|just|merely|simply|forget(?:ting)?|hesitate|fail\\s+to)\\b|n${APOS}t\\s+(?:only|just|merely|simply|forget|hesitate|fail\\s+to)\\b|\\bno\\s+(?:doubt|question)\\b|\\bwithout\\s+(?:a\\s+)?doubt\\b`;
/** Negations that hedge rather than deny: "we can't rule out a race condition". */
const HEDGING_SOURCE = `\\b(?:cannot|not)\\s+(?:be\\s+)?rule[ds]?\\s+out\\b|n${APOS}t\\s+(?:be\\s+)?rule[ds]?\\s+out\\b`;
const AFFIRMING = new RegExp(AFFIRMING_SOURCE, 'i');
const AFFIRMING_ALL = new RegExp(AFFIRMING_SOURCE, 'gi');
const HEDGING = new RegExp(HEDGING_SOURCE, 'i');
const HEDGING_ALL = new RegExp(HEDGING_SOURCE, 'gi');
/** After a negator, these turn the statement back toward the claim ("no evidence against a race"). */
const REVERSAL = /\b(?:against|except|other than|apart from|besides|unless|but for)\b/i;
const SUBORDINATE = /^\s*(?:if|when|whenever|unless|because|since|while|once|until|whether|although|though)\b/i;
const REPORTED = /\b(?:suggest(?:s|ed)?|propos(?:e|es|ed)|recommend(?:s|ed)?|advis(?:e|es|ed)|claim(?:s|ed)?|said|says|wrote|writes|mention(?:s|ed)?)\b/i;
/** The match is the subject of a directly negated predicate: "a longer timeout is not the answer". */
const NEGATED_PREDICATE = new RegExp(
  `^\\s*(?:(?:alone|itself|by itself|here|really|actually)\\s+)?(?:(?:is|are|was|were|does|do|did|would|will|should|could|can|may|might|must|has|have)\\s+(?:not|never)\\b|(?:is|are|was|were|does|do|did|would|wo|should|could|ca|has|have)n${APOS}t\\b|cannot\\b)`,
  'i',
);

/** Judges one match inside its clause. Exported for unit tests; evaluatePolarity is the entry point. */
export function classifyPolarity(text: string, match: Span, limits: PolarityLimits = POLARITY_LIMITS, boundaries: Span[] = clauseBoundaries(text)): Pick<PolarityMatch, 'clause' | 'polarity' | 'reason' | 'detail'> {
  const clause = clauseOf(text, match, boundaries);
  const excerpt = text.slice(clause.start, clause.end);
  const result = (polarity: Polarity, reason: PolarityReason, detail: string) => ({
    clause: { ...clause, excerpt: excerpt.length > limits.maxExcerpt ? `${excerpt.slice(0, limits.maxExcerpt - 3)}...` : excerpt },
    polarity,
    reason,
    detail,
  });
  const fullBefore = text.slice(clause.start, match.start);
  const cut = fullBefore.length > limits.maxWindow;
  const before = cut ? fullBefore.slice(-limits.maxWindow) : fullBefore;
  const after = text.slice(match.end, Math.min(clause.end, match.end + limits.maxWindow));

  if ((before.match(/["“”]/g)?.length ?? 0) % 2 === 1 || REPORTED.test(before)) {
    return result('ambiguous', 'quoted_or_reported', 'the phrase is quoted or reported in its clause; endorsement cannot be told from mention');
  }
  const hedged = HEDGING.test(before);
  const affirmed = AFFIRMING.test(before);
  const stripped = before.replace(HEDGING_ALL, ' ').replace(AFFIRMING_ALL, ' ');
  const negators = [...stripped.matchAll(NEGATOR)];
  const negator = negators.at(-1);
  const post = NEGATED_PREDICATE.exec(after);

  // Only part of the clause before the match was examined: a negator (or its scope) may be unseen.
  if (cut) return result('ambiguous', 'clause_too_long', `more than ${limits.maxWindow} characters of the clause precede the match`);
  if (negator) {
    const word = negator[0].toLowerCase();
    if (SUBORDINATE.test(fullBefore)) return result('ambiguous', 'subordinate_negation', `negator "${word}" sits in a subordinate clause, which does not negate the main clause`);
    if (REVERSAL.test(stripped.slice(negator.index + negator[0].length))) return result('ambiguous', 'reversed_negation', `negator "${word}" is followed by a reversing word before the match`);
    if (post) return result('ambiguous', 'double_negation', `negator "${word}" before and "${post[0].trim()}" after the match`);
    if (hedged) return result('ambiguous', 'hedge', 'a hedge ("cannot rule out") next to a negation');
    return result('negated', 'negator_before', `negator "${word}" before the match in its clause`);
  }
  if (post) return hedged ? result('ambiguous', 'hedge', 'a hedge next to a negated predicate') : result('negated', 'negated_predicate_after', `"${post[0].trim()}" directly after the match`);
  if (hedged) return result('ambiguous', 'hedge', 'a hedge ("cannot rule out") keeps the claim open');
  if (affirmed) return result('positive', 'affirming_negation', 'the negation affirms ("do not forget to", "not only", "no doubt")');
  return result('positive', 'no_negation', 'no negation in the clause');
}

/**
 * Every match of a truth pattern in `text`, each with its clause and polarity. `options.breaks` adds
 * caller-declared separators (see the header); candidates are searched from every clause start,
 * soft breaks included, and each match is judged with hard breaks only and, if there are soft ones,
 * again with them: when the two readings differ, the match is ambiguous (line_break_scope).
 */
export function evaluatePolarity(pattern: string | RegExp, text: string, limits: PolarityLimits = POLARITY_LIMITS, options: PolarityOptions = {}): PolarityResult {
  const breaks = checkBreaks(text, options.breaks ?? []);
  const hard = clauseBoundaries(text, breaks.filter((b) => b.kind === 'hard'));
  const split = breaks.some((b) => b.kind === 'soft') ? clauseBoundaries(text, breaks) : hard;
  const mode = options.candidates ?? 'text';
  if (mode !== 'text' && mode !== 'clause') throw new RangeError(`candidates ${JSON.stringify(mode)} is not text or clause`);
  if (mode === 'text') {
    const { candidates, truncated } = findCandidates(pattern, text, limits, split);
    return {
      matches: candidates.map((c) => ({ text: c.text, start: c.start, end: c.end, via: c.via, ...judge(text, c, limits, hard, split) })),
      truncated,
    };
  }
  const { candidates, truncated } = findClauseCandidates(pattern, text, limits, split);
  const direct = maskDirectAdvice(text);
  return {
    matches: candidates.map((c) => ({ text: c.text, start: c.start, end: c.end, via: c.via, ...judgeLocal(text, direct, c, limits, hard, split) })),
    truncated,
    candidates: 'clause',
  };
}

// Clause-mode advice rules. Each is a fixed word list, not a reading of the sentence:
//   direct advice   "I/we [would|do|strongly|still] recommend|suggest|propose|advise [that] [you|we]" and
//                   "my/our recommendation|suggestion|proposal|advice is|would be [to|that]" give the
//                   author's own advice. Only these exact forms are masked before judging, so the rest of
//                   the clause still decides: "I recommend that you do not fix …" stays negated, and
//                   "I do not recommend …", "I suggested …" or "he said I recommend …" are not masked.
//   advice noun     any other suggestion/advice/recommendation/proposal before the match discusses
//                   advice without giving it (whose, and whether it stands, is unknown): ambiguous.
//   rejected advice an advice noun before the match and "is/was/are/were wrong|incorrect|mistaken|
//                   misguided|a mistake" directly after it: the advice is rejected (negated).
// None of them can make a negated match positive; only direct advice can make one positive, and only
// when the masked words were the sole reason it was not (reason direct_advice).
const DIRECT_ADVICE = /\b(?:(?:I|we)\s+(?:(?:would|do|strongly|still)\s+)?(?:recommend|suggest|propose|advise)(?:\s+that)?(?:\s+(?:you|we))?|(?:my|our)\s+(?:recommendation|suggestion|proposal|advice)\s+(?:is|would\s+be)(?:\s+(?:to|that))?)\b/gi;
const ADVICE_NOUN = /\b(?:suggestion|advice|recommendation|proposal)s?\b/i;
const REJECTED_ADVICE = /^\s*(?:is|was|are|were)\s+(?:wrong|incorrect|mistaken|misguided|a\s+mistake)\b/i;

/** `text` with every direct-advice phrase replaced by spaces (same length, so offsets hold), and the masked spans. */
function maskDirectAdvice(text: string): { text: string; spans: Span[] } {
  const spans: Span[] = [];
  const masked = text.replace(DIRECT_ADVICE, (m: string, at: number) => {
    spans.push({ start: at, end: at + m.length });
    return ' '.repeat(m.length);
  });
  return { text: masked, spans };
}

/**
 * judge on the text with direct advice masked, plus the clause-mode rules. A match across a boundary
 * is ambiguous (spans_clauses); the advice rules above apply to the rest.
 */
function judgeLocal(text: string, direct: { text: string; spans: Span[] }, c: Span & { spans: boolean }, limits: PolarityLimits, hard: Span[], split: Span[]): Pick<PolarityMatch, 'clause' | 'polarity' | 'reason' | 'detail'> {
  const plain = judge(text, c, limits, hard, split);
  const clause = plain.clause;
  if (c.spans) {
    const where = hard.some((b) => b.start < c.end && b.end > c.start) ? 'a clause boundary' : 'a line break of unknown role';
    return { clause, polarity: 'ambiguous', reason: 'spans_clauses', detail: `the match crosses ${where}, so it is no single instruction (read as ${plain.polarity}: ${plain.reason})` };
  }
  const masked = direct.spans.find((s) => s.start >= clause.start && s.end <= c.start);
  const j = masked ? { ...judge(direct.text, c, limits, hard, split), clause } : plain;
  if (j.polarity !== 'positive') return j;
  const noun = ADVICE_NOUN.exec(direct.text.slice(clause.start, c.start));
  if (noun) {
    const word = noun[0].toLowerCase();
    const after = REJECTED_ADVICE.exec(text.slice(c.end, clause.end));
    if (after) return { clause, polarity: 'negated', reason: 'rejected_advice', detail: `"${word}" before and "${after[0].trim()}" after the match: the advice is rejected` };
    return { clause, polarity: 'ambiguous', reason: 'quoted_or_reported', detail: `"${word}" before the match: advice is discussed, not given` };
  }
  if (masked) return { clause, polarity: 'positive', reason: 'direct_advice', detail: `the author's own advice ("${text.slice(masked.start, masked.end)}")` };
  return j;
}

function judge(text: string, match: Span, limits: PolarityLimits, hard: Span[], split: Span[]): Pick<PolarityMatch, 'clause' | 'polarity' | 'reason' | 'detail'> {
  const across = classifyPolarity(text, match, limits, hard);
  if (split === hard) return across;
  const within = classifyPolarity(text, match, limits, split);
  if (within.polarity === across.polarity) return across;
  return {
    clause: across.clause,
    polarity: 'ambiguous',
    reason: 'line_break_scope',
    detail: `a line break of unknown role changes the reading (${across.polarity}: ${across.reason} across it, ${within.polarity}: ${within.reason} without it)`,
  };
}

/** Rejects malformed caller breaks (offsets must index `text`); duplicates are kept once. Bounded by the text length. */
function checkBreaks(text: string, breaks: readonly Break[]): Break[] {
  if (breaks.length > text.length) throw new RangeError(`${breaks.length} breaks for a text of ${text.length} characters`);
  const seen = new Map<string, Break>();
  for (const b of breaks) {
    if (!Number.isInteger(b.start) || !Number.isInteger(b.end) || b.start < 0 || b.end > text.length || b.start >= b.end) {
      throw new RangeError(`break [${b.start}, ${b.end}) is not a non-empty span of a ${text.length}-character text`);
    }
    if (b.kind !== 'hard' && b.kind !== 'soft') throw new RangeError(`break kind ${JSON.stringify(b.kind)} is not hard or soft`);
    const key = `${b.start}:${b.end}`;
    // The same span declared both ways is hard.
    if (seen.get(key)?.kind !== 'hard') seen.set(key, { start: b.start, end: b.end, kind: b.kind });
  }
  return [...seen.values()].sort((a, b) => a.start - b.start || a.end - b.end);
}

// ---------------------------------------------------------------------------
// Endorsement of one acceptable criterion (R3c step 2A; no caller yet)

export type EndorsementVerdict = 'endorsed' | 'rejected' | 'conflict' | 'unresolved' | 'none';
export type Endorsement = {
  verdict: EndorsementVerdict;
  detail: string;
  /** The positive clause-local matches that endorse (empty unless endorsed). */
  endorsing: PolarityMatch[];
  /**
   * conflict: the phrases (actionKey) that are both positive and negated. unresolved beside a positive
   * match: the phrases of the negated or ambiguous matches that keep it from counting. Otherwise empty.
   */
  contested: string[];
  /** Every match the verdict was made from, by polarity, for the audit (spanning: spans_clauses). */
  evidence: { positive: PolarityMatch[]; negated: PolarityMatch[]; ambiguous: PolarityMatch[]; spanning: PolarityMatch[] };
};

/** The identity of an action: the matched words, lower case, whitespace collapsed, edge punctuation removed. */
export function actionKey(phrase: string): string {
  return phrase.toLowerCase().replace(/\s+/g, ' ').replace(/^[\s"'“”‘’`.,;:!?]+|[\s"'“”‘’`.,;:!?]+$/g, '');
}

/**
 * Combines the clause-mode results of every pattern of ONE criterion in ONE text field. Deterministic,
 * in this order:
 *   unresolved the analysis was truncated (a retraction may be unseen).
 *   none       no match at all.
 *   unresolved matches only across clauses (spans_clauses).
 *   conflict   the same phrase (actionKey) is positive in one clause and negated in another, in either
 *              order: a direct retraction or contradiction.
 *   unresolved a positive match beside any negated or ambiguous match of the same criterion, whatever
 *              its words. One criterion's patterns may name one action in different words ("fix the
 *              backend", "fix the server", "restore the CSV attachment"), so a rejected alternative
 *              can't be told from a retraction in other words.
 *   endorsed   only positive clause-local matches.
 *   unresolved no positive match, at least one ambiguous.
 *   rejected   every clause-local match negated.
 * The verdict covers one criterion only; other criteria are judged on their own results.
 */
export function endorsement(results: readonly PolarityResult[]): Endorsement {
  if (results.some((r) => r.candidates !== 'clause')) throw new TypeError('endorsement needs evaluatePolarity results with candidates: \'clause\'');
  const bySpan = new Map<string, PolarityMatch>();
  for (const r of results) for (const m of r.matches) if (!bySpan.has(`${m.start}:${m.end}`)) bySpan.set(`${m.start}:${m.end}`, m);
  const matches = [...bySpan.values()].sort((a, b) => a.start - b.start || a.end - b.end);
  const local = matches.filter((m) => m.reason !== 'spans_clauses');
  const evidence = {
    positive: local.filter((m) => m.polarity === 'positive'),
    negated: local.filter((m) => m.polarity === 'negated'),
    ambiguous: local.filter((m) => m.polarity === 'ambiguous'),
    spanning: matches.filter((m) => m.reason === 'spans_clauses'),
  };
  const out = (verdict: EndorsementVerdict, detail: string, contested: string[] = []): Endorsement => ({ verdict, detail, endorsing: verdict === 'endorsed' ? evidence.positive : [], contested, evidence });
  const quoted = (keys: Iterable<string>) => [...new Set(keys)].map((k) => `"${k}"`).join(', ');
  if (results.some((r) => r.truncated.length > 0)) return out('unresolved', 'the analysis was truncated, so a retraction may be unseen');
  if (matches.length === 0) return out('none', 'no match');
  if (local.length === 0) return out('unresolved', 'matched only across clause boundaries');
  const { positive, negated, ambiguous } = evidence;
  if (positive.length > 0) {
    const negatedKeys = new Set(negated.map((m) => actionKey(m.text)));
    const retracted = [...new Set(positive.map((m) => actionKey(m.text)).filter((k) => negatedKeys.has(k)))];
    if (retracted.length > 0) return out('conflict', `endorsed and negated: ${quoted(retracted)}`, retracted);
    const others = [...negated, ...ambiguous].sort((a, b) => a.start - b.start);
    if (others.length > 0) {
      const contested = [...new Set(others.map((m) => actionKey(m.text)))];
      return out('unresolved', `endorsed ${quoted(positive.map((m) => actionKey(m.text)))} beside ${quoted(contested)} (${[...new Set(others.map((m) => m.polarity))].join(', ')}) in the same criterion: an alternative cannot be told from a contradiction`, contested);
    }
    return out('endorsed', `endorsed: ${quoted(positive.map((m) => actionKey(m.text)))}`);
  }
  if (ambiguous.length > 0) return out('unresolved', 'only ambiguous matches');
  return out('rejected', 'every match is negated');
}

// ---------------------------------------------------------------------------
// Line breaks (a conservative default for callers; evaluatePolarity never adds breaks itself)

const LIST_ITEM = /^\s*(?:[-*+•]|\d{1,3}[.)])\s/;
/** A line that ends in a negator or "or"/"nor" continues on the next line ("Do not\nincrease the timeout"). */
const DANGLING = new RegExp(`(?:\\b(?:not|no|never|nor|neither|or|without|avoid|avoiding|cannot)|n${APOS}t|\\binstead of|\\brather than)\\s*$`, 'i');

/**
 * One break per whitespace run that contains a line break. `hard` only where the structure says the
 * lines are separate: a blank line, or a list item that follows another item of the same block. Soft
 * otherwise, and always when the previous line ends in a negator or "or"/"nor", or when a double quote
 * is open. Runs inside code or brackets are later ignored by the shielding.
 */
export function lineBreaks(text: string): Break[] {
  const out: Break[] = [];
  let quotes = 0;
  let quotedTo = 0;
  let itemInBlock = false;
  for (const m of text.matchAll(/\s*(?:\r\n|\r|\n)\s*/g)) {
    const start = m.index;
    const end = start + m[0].length;
    const line = text.slice(Math.max(text.lastIndexOf('\n', start - 1), text.lastIndexOf('\r', start - 1)) + 1, start);
    const rest = text.slice(end);
    const next = rest.slice(0, rest.search(/[\r\n]/) < 0 ? rest.length : rest.search(/[\r\n]/));
    quotes += text.slice(quotedTo, start).match(/["“”]/g)?.length ?? 0;
    quotedTo = start;
    const blank = (m[0].match(/\r\n|\r|\n/g)?.length ?? 0) > 1;
    itemInBlock ||= LIST_ITEM.test(line);
    const structural = blank || (itemInBlock && LIST_ITEM.test(next));
    out.push({ start, end, kind: structural && !DANGLING.test(line) && quotes % 2 === 0 ? 'hard' : 'soft' });
    // A blank line ends the block: the next line starts a new one.
    if (blank) itemInBlock = false;
  }
  return out;
}

/**
 * The text with every whitespace run collapsed to one space (exactly `text.replace(/\s+/g, ' ')`, so
 * patterns find the same matches as before) and the line breaks of `lineBreaks`, mapped onto the
 * single space that replaced each run.
 */
export function collapseWhitespace(text: string): { text: string; breaks: Break[] } {
  const byStart = new Map(lineBreaks(text).map((b) => [b.start, b.kind]));
  const breaks: Break[] = [];
  let out = '';
  let at = 0;
  for (const m of text.matchAll(/\s+/g)) {
    out += text.slice(at, m.index);
    // A line-break run found by lineBreaks starts where this whitespace run starts.
    const kind = byStart.get(m.index);
    if (kind) breaks.push({ start: out.length, end: out.length + 1, kind });
    out += ' ';
    at = m.index + m[0].length;
  }
  return { text: out + text.slice(at), breaks };
}
