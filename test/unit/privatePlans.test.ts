// No file of the repository points at the private planning folder or its files (the plans, the gate reviews and
// their finding IDs, the reports): the public repository does not hold them, so such a reference points at nothing.
// A reason that needs a source names a public doc (docs/DEVELOPING.md, docs/DESIGN.md, THIRD_PARTY_NOTICES.md) or
// the upstream file, or is stated in place.

import * as assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { root } from '../support/helpers';

// The patterns are built from pieces, so this file does not match them itself. "(?<![A-Za-z0-9])" instead of "\b",
// so an ID after "_" is found too.
const j = (...parts: string[]) => parts.join('');
const edge = '(?<![A-Za-z0-9])';
export const PATTERNS: [string, RegExp][] = [
  ['the planning folder', new RegExp(j('plan', 'ning[\\\\/]'))],
  ['a private plan', new RegExp(j('PLAN', '_[A-Za-z0-9]'))],
  ['a gate review', new RegExp(j('GATE', '_|FINAL', '_GATE'))],
  ['a report or summary', new RegExp(j('[A-Z0-9]+_', 'REPORT|', 'STAGE[0-9]+_|', 'SUMM', 'ARY_|', 'REVI', 'EW_'))],
  ['a gate finding', new RegExp(j(edge, '(S[0-9]+[A-Z]?', '-[SE]-N?[0-9]|S[0-9]+', '-[SE] N(OTE )?[0-9]|S[0-9]+', '-[0-9]{2}(?![0-9])|SP2?', '-[SE]-[0-9]|EP', '-?S2?-[0-9]|EP', '-S NOTE|EPE', '2?-[0-9N])'))],
  ['a stage of the private plan', new RegExp(j(edge, 'B', '0(?![A-Za-z0-9])'))],
  // A numbered stage or a lettered track of a private plan; not the "--stage" option, nor "stage1".
  ['a numbered stage of a private plan', new RegExp(j('(?<![-A-Za-z0-9])[Ss]tage', ' [0-9](?![0-9])'))],
  ['a lettered track of a private plan', new RegExp(j(edge, '[Tt]rack', ' [A-Z](?![A-Za-z0-9])'))],
];

/** Folders that git does not track here (.gitignore) or that are not the project's own text. */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'out', 'dist', '.vscode-test', 'coverage']);
/** Binary formats, by name; any other file is read as text, even one with a NUL byte (which is itself reported). */
const BINARY = /\.(png|jpe?g|gif|ico|pdf|vsix|wasm|data|zip|gz|xz|tar|ttf|otf|pfb|woff2?|fmt)$/i;

function files(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(path.join(dir, rel))) {
    const r = rel ? `${rel}/${name}` : name;
    if (SKIP_DIRS.has(name) && !rel) continue;
    if (name.startsWith('.private-') && name !== '.private-fixtures.example.json') continue;
    if (statSync(path.join(dir, r)).isDirectory()) out.push(...files(dir, r));
    else if (!BINARY.test(name)) out.push(r);
  }
  return out;
}

function hitsOf(text: string): string[] {
  const out: string[] = [];
  for (const [what, re] of PATTERNS) if (re.test(text)) out.push(what);
  return out;
}

describe('no reference to the private plans', () => {
  it('the patterns find every form a private reference has taken, and not the public forms', () => {
    const p = (...parts: string[]) => parts.join('');
    const found = [
      p('see plan', 'ning/reviews'), p('plan', 'ning\\reviews'), p('PLAN', '_engine.md'), p('PLAN', '_v4.md'), p('GA', 'TE_ST', 'AGE1_E.md'),
      p('BUILD_GA', 'TE_2_E.md'), p('FINAL_GA', 'TE_v4.md'), p('FINAL_GA', 'TE.md'), p('ST', 'AGE1_REP', 'ORT.md'), p('B', '0_REP', 'ORT.md'),
      p('SUMM', 'ARY_engine.md'), p('REVI', 'EW_LOG.md'), p('S1', '-S-03'), p('S1', '-E-N3'), p('S2', '-E-01'), p('x_S2', '-S-05'),
      p('S1', '-S NOTE 5'), p('S2', '-02'), p('SP', '-S-03'), p('SP2', '-E-11'), p('EP', '-S-02'), p('EP', '-S NOTE 13'), p('EPE', '-16'),
      p('EPE2', '-04'), p('EPE', '-N4'), p('the B', '0 images'), p('(B', '0)'), p('S3', 'A-S-01'), p('(S3', 'B-E-08)'),
      p('St', 'age 4: the releases'), p('(st', 'age 4)'), p('st', 'age 3a'), p('tr', 'ack P: a format'), p('(Tr', 'ack F)'),
    ];
    for (const s of found) assert.ok(hitsOf(s).length > 0, s);
    const publicForms = [
      'GB1E-08', 'G2S-01', 'G2E-02', 'F2-M1', 'L5-01', 'b0, b1', '0xB0', 'B00', 'AB0', 'S2', 'page 2-02', 'the planned order', 'PLANS', 'S3A', 'S3B-01',
      p('--st', 'age pin'), p('--st', 'age 2'), p('st', 'age1'), p('st', 'ages 4'), p('backtr', 'ack P'), p('tr', 'ack record'), p('tr', 'ack 2'), p('tr', 'ack PDF'),
    ];
    for (const s of publicForms) assert.deepEqual(hitsOf(s), [], s);
  });

  it('no file names the planning folder, a private plan, a gate review, a report or a gate finding', () => {
    const hits: string[] = [];
    for (const f of files(root)) {
      const bytes = readFileSync(path.join(root, f));
      // A NUL byte in a file named as text is reported, not skipped: it would hide the file from this check.
      if (bytes.includes(0)) hits.push(`${f}: a NUL byte in a text file`);
      const lines = bytes.toString('utf8').split('\n');
      lines.forEach((line, i) => {
        for (const what of hitsOf(line)) hits.push(`${f}:${i + 1}: ${what}: ${line.trim().slice(0, 120)}`);
      });
    }
    assert.deepEqual(hits, []);
  });
});
