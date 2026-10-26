// The fresh-history script (scripts/fresh-history.mjs; G0 preparation): its 8-word comparison, the two refusals
// that come before any git command (an author needs a name and an address; the new folder must lie outside the
// repository), and the default author. The script itself runs git, so its full run is checked by hand.

import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { importScript, root } from '../support/helpers';

interface FreshHistory {
  words(text: string): string[];
  runs(text: string, n?: number): Set<string>;
  main(argv: string[]): number;
  PUBLIC_AUTHOR: string;
}

describe('fresh history script (G0 preparation)', () => {
  let fh: FreshHistory;
  before(async () => {
    fh = await importScript<FreshHistory>('scripts/fresh-history.mjs');
  });

  it('compares runs of 8 words, ignoring case and punctuation', () => {
    assert.deepEqual(fh.words('Größe: 3 Ångström, x_2!'), ['größe', '3', 'ångström', 'x', '2']);
    const a = fh.runs('one two three four five six seven eight nine');
    assert.deepEqual([...a], ['one two three four five six seven eight', 'two three four five six seven eight nine']);
    assert.ok(fh.runs('ONE, two; three four five six seven eight').has('one two three four five six seven eight'));
    assert.equal(fh.runs('too short to make a run').size, 0);
  });

  it('refuses an author without an address, or the new folder inside the repository', () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (m: string) => errors.push(m);
    try {
      assert.equal(fh.main(['--author', 'no address']), 2);
      assert.equal(fh.main(['--author']), 2);
      assert.equal(fh.main(['--author', 'A Name <a@example.invalid>', '--out', path.join(root, 'inside')]), 2);
      assert.equal(fh.main(['--out', path.join(root, 'inside')]), 2);
    } finally {
      console.error = original;
    }
    assert.match(errors[0], /--author "NAME <EMAIL>"/);
    assert.match(errors[2], /must be outside this repository/);
    assert.match(errors[3], /must be outside this repository/);
  });

  it('commits as the GitHub account the owner chose, with its no-reply address', () => {
    assert.equal(fh.PUBLIC_AUTHOR, 'haberwooki <189794217+haberwooki@users.noreply.github.com>');
  });
});
