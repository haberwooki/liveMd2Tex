// A preset's patterns cannot hold the extension host's thread (docs/DESIGN.md#presets). Entry globs are
// matched by glob.ts (a 12-star glob took 233 s as a RegExp), and the work of the safe matcher is capped: pattern
// size, number of patterns, text length, and a budget of automaton steps per conversion. The work is checked by
// the matcher's own step count, which no busy machine changes; each check on the clock is a generous sanity check.

import * as assert from 'node:assert/strict';
import { convertMarkdown } from '../../src/converter/markdownToLatex';
import { globMatches, MAX_GLOB_LENGTH } from '../../src/converter/preset/glob';
import { MAX_DROP_LINES, MAX_ENTRIES, modeForFile, parsePresetFile, resolveMode, type PresetFile } from '../../src/converter/preset/load';
import { compileSafePattern, MAX_STATES, MAX_TEXT_LENGTH, PATTERN_BUDGET, withPatternBudget, type SafePattern } from '../../src/converter/preset/safePattern';
// The clock checks a busy machine cannot break: under the fixed limit, or within a multiple of a reference.
import { timeOf, withinClock } from '../support/clock';

const BS = '\\';

/** The largest pattern of a shape that the matcher accepts (at the state cap). */
function largest(make: (n: number) => string): string {
  for (let n = 100; n > 0; n--) {
    try {
      compileSafePattern(make(n));
      return make(n);
    } catch {
      // too large: try a smaller one
    }
  }
  throw new Error('no size fits');
}

/** The time to spend one whole step budget: 20 unanchored patterns on 1,000 lines of 4,000 characters. */
function fullBudgetMs(): number {
  const patterns = Array.from({ length: MAX_DROP_LINES }, (_, k) => compileSafePattern(`zz${k}`));
  const lines = Array.from({ length: 1000 }, () => 'a'.repeat(MAX_TEXT_LENGTH - 1));
  return timeOf(() => {
    withPatternBudget(() => {
      for (const line of lines) {
        patterns.some((p) => p.test(line));
      }
    });
  });
}

/** Patterns at the caps that keep every automaton state alive on a line of "a": the matcher's worst case. */
const WORST = [
  largest((n) => `.{0,${n}}b`),
  largest((n) => `[ab]{0,${n}}c`),
  largest((n) => `(.{0,${n}}){0,9}z`),
  largest((n) => `(a|aa){0,${n}}$`),
];

describe('preset patterns are bounded', () => {
  it('matches entry globs without RegExp, as the RegExp did on ordinary globs', () => {
    const toRegExp = (glob: string) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, `${BS}$&`).replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`, 'i');
    const globs = ['manuscript.md', 'paper*.md', 'si*.md', '*.md', '*', 'a?c.md', '*-notes-*.md', '*a*b*c*', 'x', '', 'Paper*.MD', '**.md', '*?'];
    const names = ['manuscript.md', 'paper.md', 'paper-v2.md', 'PAPER_final.md', 'si.md', 'supplement.md', 'abc.md', 'a-c.md', 'group-notes-1.md', 'aXbYc', 'x', '', 'notes.markdown'];
    for (const g of globs) {
      for (const n of names) {
        assert.equal(globMatches(g, n), toRegExp(g).test(n), `"${g}" on "${n}"`);
      }
    }
  });

  it('matches a 14-star entry at once (233 s for 12 stars as a RegExp)', () => {
    const preset = { name: 'p', modes: { a: { entry: `${'*'.repeat(14)}#` }, b: { entry: '*.md' } } } as unknown as PresetFile;
    const plain = { name: 'p', modes: { b: { entry: '*.md' } } } as unknown as PresetFile;
    const reference = timeOf(() => {
      for (let k = 0; k < 100; k++) {
        modeForFile(plain, 'notes-for-the-group-meeting.md');
      }
    });
    const elapsed = timeOf(() => {
      for (let k = 0; k < 100; k++) {
        assert.equal(modeForFile(preset, 'notes-for-the-group-meeting.md'), 'b');
      }
    });
    assert.ok(withinClock(elapsed, 100, reference, 200), `${Math.round(elapsed)} ms for 100 lookups (${reference.toFixed(2)} ms with one plain entry)`);
    assert.equal(globMatches('*'.repeat(MAX_GLOB_LENGTH + 1), 'a.md'), false);
  });

  it('reports and caps entry globs and dropLines', () => {
    const entries = Array.from({ length: MAX_ENTRIES + 5 }, (_, k) => `f${k}.md`);
    const many = parsePresetFile(JSON.stringify({ name: 'p', modes: { a: { entry: entries }, b: { entry: [`${'x'.repeat(MAX_GLOB_LENGTH + 1)}`, 'late.md'] } } }));
    assert.ok(many.problems.some((p) => /only the first 100/.test(p)), many.problems.join(' | '));
    assert.ok(many.problems.some((p) => /longer than 200/.test(p)) === false); // the long one is past the cap
    assert.equal(modeForFile(many.preset as PresetFile, 'late.md'), undefined); // past the cap
    const long = parsePresetFile(JSON.stringify({ name: 'p', modes: { a: { entry: 'x'.repeat(MAX_GLOB_LENGTH + 1) } } }));
    assert.ok(long.problems.some((p) => /longer than 200/.test(p)));

    const drops = Array.from({ length: MAX_DROP_LINES + 3 }, (_, k) => `^drop${k}$`);
    const { preset } = parsePresetFile(JSON.stringify({ name: 'p', modes: { a: { appendix: { heading: 'M', dropLines: drops } } } }));
    const resolved = resolveMode(preset as PresetFile, 'a');
    assert.equal(resolved.mode.appendix?.dropLines.length, MAX_DROP_LINES);
    assert.ok(resolved.problems.some((p) => /only the first 20/.test(p)));
  });

  it('refuses patterns over the state cap and does not test texts over the length cap', () => {
    assert.ok(WORST.every((p) => p.length < 30));
    assert.throws(() => compileSafePattern('.{0,100}b'), /too large|above/);
    assert.ok(MAX_STATES <= 200);
    const { value, budget } = withPatternBudget(() => compileSafePattern('a').test('a'.repeat(MAX_TEXT_LENGTH + 1)));
    assert.equal(value, false);
    assert.equal(budget.tooLong, 1);
  });

  it('stops at the budget: every later test answers "no match", and the converter warns', () => {
    const re = compileSafePattern(WORST[0]);
    const line = 'a'.repeat(MAX_TEXT_LENGTH);
    const { budget } = withPatternBudget(() => {
      for (let k = 0; k < 1000; k++) {
        re.test(line);
      }
    });
    assert.equal(budget.exhausted, true);
    // Once spent, even an easy match is refused.
    const { value } = withPatternBudget(() => {
      for (let k = 0; k < 1000; k++) {
        re.test(line);
      }
      return compileSafePattern('a').test('a');
    });
    assert.equal(value, false);
  });

  it('worst case at every cap: 20 patterns of 200 states, a 1 MB line and 200 lines of 4,000 characters, within the step budget', () => {
    const dropLines = Array.from({ length: MAX_DROP_LINES }, (_, k) => WORST[k % WORST.length]);
    const { preset } = parsePresetFile(
      JSON.stringify({ name: 'worst', modes: { paper: { entry: '*', preambleFile: 'p.tex', appendix: { heading: 'Methods', dropLines } } } }),
    );
    const resolved = resolveMode(preset as PresetFile, 'paper', { 'p.tex': `${BS}documentclass{article}` });
    assert.deepEqual(resolved.problems, []);
    const appendix = ['a'.repeat(1_000_000), ...Array.from({ length: 200 }, () => 'a'.repeat(MAX_TEXT_LENGTH - 1))].join('\n');
    const reference = fullBudgetMs();
    let result!: ReturnType<typeof convertMarkdown>;
    const total = timeOf(() => {
      result = convertMarkdown('Body text.\n', { preset: resolved.mode, appendix });
    });
    const work = result.patternWork;
    assert.ok(work, 'no pattern work recorded');
    // The bound is the matcher's own step count, not the clock: the budget, plus what one character's work can add
    // before the matcher checks it (two passes over at most MAX_STATES states).
    assert.ok(work.steps <= PATTERN_BUDGET + 2 * MAX_STATES, `${work.steps} steps`);
    const codes = result.diagnostics.map((d) => d.code);
    assert.ok(codes.includes('preset-patterns') && codes.includes('preset-pattern-length'), codes.join(','));
    // One generous sanity check on the clock: the conversion costs about one step budget, so it takes under 2 s,
    // or under 10 times one budget measured just before, under the same load.
    assert.ok(withinClock(total, 2000, reference, 10), `${Math.round(total)} ms for the whole conversion (${Math.round(reference)} ms for one budget)`);
  });

  it('counts reading the text too: each character read is a step, so 20 patterns on 4 MB of long lines stay inside the budget', () => {
    const lines = Array.from({ length: 1000 }, (_, k) => `${k % 2 ? 'é' : 'a'}`.repeat(MAX_TEXT_LENGTH - 1));
    /** The steps a set of patterns spends on some texts, from the budget's own count. */
    const work = (patterns: SafePattern[], texts: string[]) => {
      const { budget } = withPatternBudget(() => {
        for (const text of texts) {
          patterns.some((p) => p.test(text));
        }
      });
      return { steps: PATTERN_BUDGET - budget.left, exhausted: budget.exhausted };
    };
    const anchored = Array.from({ length: MAX_DROP_LINES }, (_, k) => compileSafePattern(`^x${k}`));
    const unanchored = Array.from({ length: MAX_DROP_LINES }, (_, k) => compileSafePattern(`zz${k}`));
    const reference = fullBudgetMs();
    const t0 = performance.now();

    // An unanchored search reads every character, and each one costs steps: at least one, and here at most three
    // (the start state, the character, its one transition).
    const one = work([unanchored[0]], [lines[0]]);
    assert.ok(one.steps >= lines[0].length && one.steps <= 3 * lines[0].length + 3, `${one.steps} steps for ${lines[0].length} characters`);

    // An anchored pattern stops at a line's first character: a 3,999-character line costs what a 2-character one does,
    // and 1,000 such lines cost exactly 1,000 times one line, far inside the budget.
    const short = work(anchored, ['ab']);
    assert.equal(work(anchored, [lines[0]]).steps, short.steps);
    assert.equal(work(anchored, [lines[1]]).steps, short.steps);
    const all = work(anchored, lines);
    assert.equal(all.exhausted, false);
    assert.equal(all.steps, lines.length * short.steps);
    assert.ok(all.steps < PATTERN_BUDGET / 10, `${all.steps} steps`);

    // Unanchored, the same lines would take about 20 x 1,000 x 4,000 characters: the budget stops the work at
    // exactly its size, and every later test answers at once.
    const scan = work(unanchored, lines);
    assert.equal(scan.exhausted, true);
    assert.equal(scan.steps, PATTERN_BUDGET);

    // One generous sanity check on the clock: about one budget of work here, so under 2 s, or under 10 times one
    // budget measured just before, under the same load.
    const elapsed = performance.now() - t0;
    assert.ok(withinClock(elapsed, 2000, reference, 10), `${Math.round(elapsed)} ms (${Math.round(reference)} ms for one budget)`);
  });

  it('ordinary patterns on an ordinary appendix stay far inside the budget', () => {
    const { preset } = parsePresetFile(
      JSON.stringify({
        name: 'plain',
        modes: { paper: { preambleFile: 'p.tex', figures: { label: 'Figure|Fig.' }, appendix: { heading: 'Methods', dropLines: [`^#${BS}s`, `^##${BS}s+Methods${BS}s*$`, `^${BS}s*>`, 'TODO'] } } },
      }),
    );
    const resolved = resolveMode(preset as PresetFile, 'paper', { 'p.tex': `${BS}documentclass{article}` });
    const appendix = Array.from({ length: 2000 }, (_, k) => (k % 50 === 0 ? `## Part ${k}` : `Line ${k} of the methods, with a few words, a number ${k * 3} and a TODO-free sentence.`)).join('\n');
    const result = convertMarkdown('**Figure 1.** A caption.\n\n![](a.png)\n', { preset: resolved.mode, appendix });
    assert.ok(!result.diagnostics.some((d) => d.code.startsWith('preset-pattern')));
    assert.ok((result.patternWork?.steps ?? 0) < PATTERN_BUDGET / 2, `${result.patternWork?.steps} steps`);
  });
});
