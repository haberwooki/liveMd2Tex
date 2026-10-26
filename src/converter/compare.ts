// The normalised diff (docs/DESIGN.md#testing): two LaTeX files compared with comments, whitespace and line
// wrapping ignored. Both are cut into TeX-like tokens (control words, control symbols, runs of letters and
// digits, single characters), whitespace dropped; a patience diff (unique tokens as anchors, a small LCS between
// them) finds the differing stretches, each one hunk. An allow-list names the hunks that are intended; it is
// capped (at 10 entries) so a comparison cannot pass by growing it.

export interface Hunk {
  /** The differing tokens, joined by single spaces ('' for an insertion or deletion). */
  reference: string;
  ours: string;
  /** A few tokens of the reference before the hunk, to find it by eye. */
  context: string;
}

export interface AllowEntry {
  reference: string;
  ours: string;
  reason: string;
}

/** Comments removed (a % not preceded by a backslash, to the end of the line). */
export function stripComments(latex: string): string {
  return latex
    .split('\n')
    .map((line) => {
      for (let i = 0; i < line.length; i++) {
        if (line[i] === '\\') {
          i++;
        } else if (line[i] === '%') {
          return line.slice(0, i);
        }
      }
      return line;
    })
    .join('\n');
}

export function latexTokens(latex: string): string[] {
  const text = stripComments(latex);
  const out: string[] = [];
  const re = /\\[A-Za-z@]+\*?|\\[^A-Za-z@\s]|[\p{L}\p{N}]+|\S/gu;
  for (const m of text.matchAll(re)) {
    out.push(m[0]);
  }
  return out;
}

type Range = [number, number];

/** Longest increasing subsequence of pairs by their second element (patience sorting). */
function lis(pairs: [number, number][]): [number, number][] {
  const tails: number[] = [];
  const prev: number[] = new Array(pairs.length).fill(-1);
  for (let i = 0; i < pairs.length; i++) {
    const v = pairs[i][1];
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[tails[mid]][1] < v) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    if (lo > 0) {
      prev[i] = tails[lo - 1];
    }
    tails[lo] = i;
  }
  const result: [number, number][] = [];
  for (let k = tails.length ? tails[tails.length - 1] : -1; k >= 0; k = prev[k]) {
    result.push(pairs[k]);
  }
  return result.reverse();
}

/** Matched index pairs between a[ar] and b[br]. */
function match(a: string[], b: string[], ar: Range, br: Range, out: [number, number][]): void {
  let [a0, a1] = ar;
  let [b0, b1] = br;
  while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) {
    out.push([a0++, b0++]);
  }
  const tail: [number, number][] = [];
  while (a1 > a0 && b1 > b0 && a[a1 - 1] === b[b1 - 1]) {
    tail.push([--a1, --b1]);
  }
  if (a0 < a1 && b0 < b1) {
    const count = new Map<string, { a: number; b: number; ai: number; bi: number }>();
    for (let i = a0; i < a1; i++) {
      const c = count.get(a[i]) ?? { a: 0, b: 0, ai: i, bi: -1 };
      c.a++;
      count.set(a[i], c);
    }
    for (let j = b0; j < b1; j++) {
      const c = count.get(b[j]);
      if (c) {
        c.b++;
        c.bi = j;
      }
    }
    const anchors = lis(
      [...count.values()]
        .filter((c) => c.a === 1 && c.b === 1)
        .map((c) => [c.ai, c.bi] as [number, number])
        .sort((x, y) => x[0] - y[0]),
    );
    if (anchors.length > 0) {
      let pa = a0;
      let pb = b0;
      for (const [ai, bi] of anchors) {
        match(a, b, [pa, ai], [pb, bi], out);
        out.push([ai, bi]);
        pa = ai + 1;
        pb = bi + 1;
      }
      match(a, b, [pa, a1], [pb, b1], out);
    } else if ((a1 - a0) * (b1 - b0) <= 4_000_000) {
      // A plain LCS for a small stretch with no unique anchors.
      const n = a1 - a0;
      const m = b1 - b0;
      const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
      for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
          dp[i][j] = a[a0 + i] === b[b0 + j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
      }
      let i = 0;
      let j = 0;
      while (i < n && j < m) {
        if (a[a0 + i] === b[b0 + j]) {
          out.push([a0 + i, b0 + j]);
          i++;
          j++;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
          i++;
        } else {
          j++;
        }
      }
    }
  }
  out.push(...tail.reverse());
}

/** The differing stretches between a reference LaTeX file and ours, comments and whitespace ignored. */
export function normalisedDiff(reference: string, ours: string): Hunk[] {
  const a = latexTokens(reference);
  const b = latexTokens(ours);
  const pairs: [number, number][] = [];
  match(a, b, [0, a.length], [0, b.length], pairs);
  pairs.sort((x, y) => x[0] - y[0]);
  pairs.push([a.length, b.length]);
  const hunks: Hunk[] = [];
  let pa = 0;
  let pb = 0;
  for (const [ai, bi] of pairs) {
    if (ai > pa || bi > pb) {
      hunks.push({
        reference: a.slice(pa, ai).join(' '),
        ours: b.slice(pb, bi).join(' '),
        context: a.slice(Math.max(0, pa - 8), pa).join(' '),
      });
    }
    pa = ai + 1;
    pb = bi + 1;
  }
  return hunks;
}

/** The hunks the allow-list does not explain, and the entries that matched no hunk (stale). */
export function applyAllowList(hunks: Hunk[], allow: AllowEntry[]): { unexplained: Hunk[]; stale: AllowEntry[] } {
  const used = new Set<AllowEntry>();
  const unexplained = hunks.filter((h) => {
    const entry = allow.find((e) => e.reference === h.reference && e.ours === h.ours);
    if (entry) {
      used.add(entry);
      return false;
    }
    return true;
  });
  return { unexplained, stale: allow.filter((e) => !used.has(e)) };
}
