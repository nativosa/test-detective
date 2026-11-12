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

export type Span = { start: number; end: number };
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
  | 'clause_too_long';

export type PolarityMatch = {
  /** The matched phrase, exactly text.slice(start, end). */
  text: string;
  start: number;
  end: number;
  /** full_text: the pattern matched the whole text; clause_suffix: only when matched from a clause start. */
  via: 'full_text' | 'clause_suffix';
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
 * numbers stay whole. Sorted, overlapping separators merged.
 */
export function clauseBoundaries(text: string): Span[] {
  const shielded = shieldedPositions(text);
  const found: Span[] = [];
  const add = (re: RegExp) => {
    for (const m of text.matchAll(re)) if (!shielded[m.index]) found.push({ start: m.index, end: m.index + m[0].length });
  };
  add(/[.!?;]\s+/g);
  add(/,\s+/g);
  add(/:\s+(?!(?:true|false|null|undefined|-?\d|['"`{[]))/gi);
  add(/\s+(?:and|but|then|so|yet|however|whereas|although|though)\s+/gi);
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

/** Every match of a truth pattern in `text`, each with its clause and polarity. */
export function evaluatePolarity(pattern: string | RegExp, text: string, limits: PolarityLimits = POLARITY_LIMITS): PolarityResult {
  const boundaries = clauseBoundaries(text);
  const { candidates, truncated } = findCandidates(pattern, text, limits, boundaries);
  return {
    matches: candidates.map((c) => ({ text: c.text, start: c.start, end: c.end, via: c.via, ...classifyPolarity(text, c, limits, boundaries) })),
    truncated,
  };
}
