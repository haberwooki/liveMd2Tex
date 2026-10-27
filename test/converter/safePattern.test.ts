// A preset's patterns are untrusted (docs/DESIGN.md#presets). They are matched by src/converter/preset/safePattern.ts
// (a restricted language, matched in linear time), never by RegExp. These tests would have caught the finding: a
// pattern with catastrophic backtracking given to RegExp freezes the process; here it finishes at once.

import * as assert from 'node:assert/strict';
import { compileSafePattern, MAX_PATTERN_LENGTH, PatternError } from '../../src/converter/preset/safePattern';
import { convertMarkdown } from '../../src/converter/markdownToLatex';
import { parsePresetFile, resolveMode } from '../../src/converter/preset/load';
import { clockMessage, timeOf, withinClock } from '../support/clock';
import { examplePreset } from './support';

describe('preset patterns in a safe language', () => {
  it('agrees with RegExp on the language it accepts', () => {
    const patterns = [
      '^#\\s', '^##\\s+Methods\\s*$', '^\\s*>', '^(?:Figure|Table)\\b', 'a.c', '^a*$', 'colou?r', '[A-Z][a-z]{2,4}\\d',
      '[^a-z]', '\\bword\\b', '\\Bor\\B', 'x{3}', 'x{2,}', '(ab)+c', '(?:a|b)*?c', '\\.', '[\\]\\-]', '[a-c-]', '\\x41\\u00e9',
      '\\t|\\n', '^$', '\\W+', '[\\d.]+%',
    ];
    const texts = ['# Title', '## Methods', '##  Methods  ', '> quote', '  > quote', 'Figure 3.', 'Tables', 'Table 2', 'abc', 'aXc', 'aaaa',
      '', 'color', 'colour', 'Abcd5', 'Ab1', 'word', 'a word here', 'sword', 'xxx', 'xx', 'ababc', 'abbac', 'a.b', ']', '-', 'Aé', '\t',
      '12.5%', 'no match here', 'word.'];
    for (const p of patterns) {
      const safe = compileSafePattern(p);
      const native = new RegExp(p);
      for (const t of texts) {
        assert.equal(safe.test(t), native.test(t), `"${p}" on "${t}"`);
      }
    }
  });

  it('matches in linear time: patterns that make RegExp backtrack for ever finish at once', () => {
    const long = `${'a'.repeat(3998)}!`; // the longest text a pattern is tested on
    const run = (p: string) =>
      timeOf(() => {
        const safe = compileSafePattern(p);
        safe.test(long);
        safe.test(' '.repeat(3998) + 'x');
      });
    // The reference: a plain pattern that reads every character too. In linear time the hostile patterns cost a few
    // times as much (more automaton states); a pattern that backtracks would cost millions of times as much.
    const reference = run('a+$') + run('\\s+$');
    for (const p of ['(a+)+$', '(a|a)*$', '(a*)*b', '^(\\w+\\s?)*$', '(x+x+)+y', '\\s*\\s*\\s*\\s*$']) {
      const elapsed = run(p);
      assert.ok(withinClock(elapsed, 2000, reference, 50), clockMessage(`"${p}"`, elapsed, 2000, reference, 50));
    }
  });

  it('refuses back-references, look-arounds, flags-like escapes, oversized patterns', () => {
    for (const [p, why] of [
      ['(a)\\1', /back-references/],
      ['(?=a)b', /look-arounds/],
      ['(?<n>a)', /look-arounds|named/],
      ['\\p{L}', /not supported/],
      ['a**', /two quantifiers/],
      ['*a', /nothing before/],
      ['(a', /not closed/],
      ['a)', /unmatched|unexpected/],
      ['a{10}{10}', /two quantifiers/],
      ['a{101}', /above 100/],
      ['(a{50}){20}', /too large/],
      ['.{0,100}b', /too large/],
      ['x'.repeat(MAX_PATTERN_LENGTH + 1), /longer than/],
    ] as const) {
      assert.throws(() => compileSafePattern(p), (err: unknown) => err instanceof PatternError && why.test(err.message), p);
    }
  });

  it('a preset with an unusable pattern is loaded with a problem, and the pattern is not used', () => {
    const { preset } = parsePresetFile(
      JSON.stringify({
        name: 'hostile',
        modes: { paper: { figures: { label: '(?<=x)Figure' }, appendix: { heading: 'Methods', dropLines: ['^(a+)+$', '(a)\\1', '^# '] } } },
      }),
    );
    assert.ok(preset);
    const resolved = resolveMode(preset, 'paper');
    assert.equal(resolved.problems.filter((p) => /pattern/.test(p)).length, 2, resolved.problems.join(' | '));
    assert.deepEqual(resolved.mode.appendix?.dropLines, ['^(a+)+$', '^# ']); // the first is fine in the safe language
    // Converting with it is quick even on a line built to make RegExp backtrack. The reference: the same conversion
    // with a plain pattern that reads the whole line too.
    const appendix = `${'a'.repeat(30000)}!\n# Dropped\nKept.`;
    const plainPreset = parsePresetFile(JSON.stringify({ name: 'plain', modes: { paper: { appendix: { heading: 'Methods', dropLines: ['a+$', '^# '] } } } })).preset;
    assert.ok(plainPreset);
    const plain = resolveMode(plainPreset, 'paper');
    const reference = timeOf(() => convertMarkdown('Body.', { preset: plain.mode, appendix }));
    const elapsed = timeOf(() => convertMarkdown('Body.', { preset: resolved.mode, appendix }));
    assert.ok(withinClock(elapsed, 3000, reference, 20), clockMessage('the hostile preset', elapsed, 3000, reference, 20));
  });

  it('the example preset\'s patterns are all in the language: it loads with no problem', () => {
    const { preset, files } = examplePreset();
    for (const mode of Object.keys(preset.modes)) {
      assert.deepEqual(resolveMode(preset, mode, files).problems, [], mode);
    }
  });
});
