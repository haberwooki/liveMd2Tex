// The data images' file name database (src/engine-host/engine/lsR.ts): the engine host writes /texmf-extra/ls-R
// from the files it has mounted there, so kpathsea looks an add-on's files up in it and never searches the tree on
// disk (docs/DESIGN.md, "Mounting"). Its text is the one the image builder writes (scripts/lib/texmf-config.mjs).

import * as assert from 'node:assert/strict';
import { lsR } from '../../src/engine-host/engine/lsR';
import { importScript } from '../support/helpers';

const paths = [
  'tex/latex/pkg/pkg.sty',
  'tex/latex/pkg/pkg-data.def',
  'tex/latex/other/other.sty',
  'tex/generic/gen/gen.tex',
  'fonts/opentype/foundry/Font-Regular.otf',
  'fonts/tfm/foundry/font.tfm',
  'README',
];

describe('the data images\' ls-R (lsR.ts)', () => {
  it('is the text the image builder writes (scripts/lib/texmf-config.mjs), in any input order', async () => {
    const builder = await importScript<{ lsR(p: Iterable<string>): string }>('scripts/lib/texmf-config.mjs');
    assert.equal(lsR(paths), builder.lsR(paths));
    assert.equal(lsR([...paths].reverse()), builder.lsR(paths));
    assert.equal(lsR([]), builder.lsR([]));
  });

  it('starts with kpathsea\'s header line and lists every file under its folder', () => {
    const text = lsR(paths);
    const lines = text.split('\n');
    assert.equal(lines[0], '% ls-R -- filename database for kpathsea; do not change this line.');
    assert.ok(text.endsWith('\n'));
    // Each folder's section: "./path:", its entries, a blank line.
    const sections = new Map<string, string[]>();
    let current: string[] | undefined;
    for (const line of lines.slice(1)) {
      const dir = /^\.\/(.*):$/.exec(line);
      if (dir) {
        current = [];
        sections.set(dir[1], current);
      } else if (line && current) {
        current.push(line);
      }
    }
    for (const p of paths) {
      const slash = p.lastIndexOf('/');
      const folder = slash < 0 ? '' : p.slice(0, slash);
      assert.ok(sections.get(folder)?.includes(p.slice(slash + 1)), `${p} is not listed`);
    }
    assert.deepEqual(sections.get('tex/latex'), ['other', 'pkg']);
    assert.deepEqual(sections.get(''), ['README', 'fonts', 'tex']);
  });

  it('with no files, is the header and an empty top folder', () => {
    assert.equal(lsR([]), '% ls-R -- filename database for kpathsea; do not change this line.\n./:\n\n');
  });
});
