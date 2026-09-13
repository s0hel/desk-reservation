/**
 * Desk naming patterns for bulk creation (TDD §14.3, FR-8.2).
 *
 * Bulk creation is the primary path, not a convenience: an admin placing 300 desks one
 * at a time abandons onboarding (PRD risk R5). What makes it usable is that the names
 * come out right, because renaming 300 desks afterwards is the same abandonment by
 * another route.
 *
 * A pattern is a literal string with one or more ranges:
 *
 *   4F-A-{01..24}     -> 4F-A-01 … 4F-A-24   (zero-padded to the width written)
 *   4F-{A..E}-{1..12} -> 4F-A-1 … 4F-E-12    (letters count too)
 *
 * Two ranges is the useful maximum in practice — rows and columns — but nothing here
 * assumes that. Ranges are expanded left to right, so the FIRST range varies slowest,
 * which is what makes `{A..E}` read as rows and `{1..12}` as columns.
 */

export type Range = {
  kind: "number" | "letter";
  from: string;
  to: string;
  /** Zero-padding width, taken from how the pattern was written ("01" -> 2). */
  width: number;
};

export type ParsedPattern = { literals: string[]; ranges: Range[] };

export class PatternError extends Error {}

const RANGE = /\{([^{}]*)\}/g;

function parseRange(body: string): Range {
  const parts = body.split("..");
  if (parts.length !== 2) {
    throw new PatternError(`"{${body}}" should look like {01..24} or {A..E}`);
  }
  const [from, to] = parts.map((p) => p.trim());
  if (!from || !to) throw new PatternError(`"{${body}}" is missing one end of the range`);

  if (/^\d+$/.test(from) && /^\d+$/.test(to)) {
    // Padding is how the START of the range is written, not the widest end: {01..12}
    // gives 01..12, {1..100} gives 1..100. Taking the maximum instead would turn
    // {1..100} into 001..100, which is not what anyone typed.
    return { kind: "number", from, to, width: from.length };
  }
  if (/^[A-Za-z]$/.test(from) && /^[A-Za-z]$/.test(to)) {
    return { kind: "letter", from, to, width: 1 };
  }
  throw new PatternError(`"{${body}}" must be two numbers or two single letters`);
}

export function parsePattern(pattern: string): ParsedPattern {
  const literals: string[] = [];
  const ranges: Range[] = [];
  let cursor = 0;

  for (const match of pattern.matchAll(RANGE)) {
    literals.push(pattern.slice(cursor, match.index));
    ranges.push(parseRange(match[1]));
    cursor = match.index + match[0].length;
  }
  literals.push(pattern.slice(cursor));

  if (pattern.includes("{") && ranges.length === 0) {
    throw new PatternError("Unclosed { in the pattern");
  }
  return { literals, ranges };
}

function valuesOf(range: Range): string[] {
  if (range.kind === "letter") {
    const start = range.from.charCodeAt(0);
    const end = range.to.charCodeAt(0);
    const step = end >= start ? 1 : -1;
    const out: string[] = [];
    for (let c = start; step > 0 ? c <= end : c >= end; c += step) {
      out.push(String.fromCharCode(c));
    }
    return out;
  }
  const start = Number(range.from);
  const end = Number(range.to);
  const step = end >= start ? 1 : -1;
  const out: string[] = [];
  for (let n = start; step > 0 ? n <= end : n >= end; n += step) {
    out.push(String(n).padStart(range.width, "0"));
  }
  return out;
}

/** How many names a pattern would produce, without producing them. */
export function patternSize(pattern: string): number {
  const { ranges } = parsePattern(pattern);
  return ranges.reduce((total, range) => total * valuesOf(range).length, 1);
}

/**
 * Expand a pattern into names.
 *
 * `limit` is a guard, not a preference: `{1..100000}` is a typo, and the editor should
 * say so rather than lock the browser building a million strings.
 */
export function expandPattern(pattern: string, limit = 2000): string[] {
  const { literals, ranges } = parsePattern(pattern);
  if (ranges.length === 0) return [pattern];

  const size = ranges.reduce((total, range) => total * valuesOf(range).length, 1);
  if (size > limit) {
    throw new PatternError(`That pattern makes ${size} names; the limit is ${limit}`);
  }

  const columns = ranges.map(valuesOf);
  const names: string[] = [];

  const build = (depth: number, parts: string[]): void => {
    if (depth === columns.length) {
      names.push(literals.map((literal, i) => literal + (parts[i] ?? "")).join(""));
      return;
    }
    for (const value of columns[depth]) build(depth + 1, [...parts, value]);
  };
  build(0, []);
  return names;
}

/**
 * The names a grid of `rows` x `columns` needs, in the order cells are laid out
 * (left to right, top to bottom).
 *
 * Returns fewer names than cells when the pattern is too small, and the caller reports
 * that rather than silently generating `undefined` codes — which is how a bulk import
 * ends up with a desk literally named "undefined".
 */
export function namesForGrid(pattern: string, rows: number, columns: number): string[] {
  return expandPattern(pattern).slice(0, rows * columns);
}

/** Names that already exist, so the editor can say so before the save fails. */
export function clashingNames(names: string[], taken: Iterable<string>): string[] {
  const existing = new Set(Array.from(taken, (code) => code.toLowerCase()));
  const seen = new Set<string>();
  const clashes: string[] = [];
  for (const name of names) {
    const folded = name.toLowerCase();
    // Codes are unique per site and compared case-insensitively by the API, so a
    // pattern that collides with itself has to count too.
    if (existing.has(folded) || seen.has(folded)) clashes.push(name);
    seen.add(folded);
  }
  return clashes;
}

/**
 * "4F-A-01" -> "A-01". Plan labels drop the floor prefix, which every desk on the floor
 * shares — the same rule the mobile viewer uses (`apps/mobile/src/lib/plan.ts`), so a
 * desk reads the same in the editor and in the app.
 */
export function shortLabel(code: string): string {
  const parts = code.split("-");
  return parts.length > 2 ? parts.slice(1).join("-") : code;
}
