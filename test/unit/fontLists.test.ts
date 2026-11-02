// The data builder's font lists (scripts/build-bundle.mjs, fontLists): one list in each image, the core's by its
// image's file names and the add-on's relative to its top, ordered and checked as the engine host joins them.
// On fonts of the pinned CTAN set (DejaVu, engine/pins.json); skipped when they have not been fetched.

import * as assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { importScript, root } from '../support/helpers';

type Lists = { core: Buffer; extra: Buffer; problems: string[]; report: { core: { files: number; faces: number }; extra: { files: number; faces: number }; collisions: number; rules: number } };
type Rule = { name: string; first: string };

describe('the data builder\'s font lists (build-bundle.mjs, fontLists)', function () {
  const dejavu = path.resolve(root, '..', 'engine_assets', 'ctan-dejavu', 'truetype');
  const font = (name: string) => readFileSync(path.join(dejavu, name));
  let fontLists: (core: Map<string, Buffer>, extra: Map<string, Buffer>, sets: Record<string, { fontOrder?: Rule[] }>) => Promise<Lists>;

  before(async function () {
    if (!existsSync(path.join(dejavu, 'DejaVuSans.ttf'))) {
      this.skip();
    }
    ({ fontLists } = await importScript<{ fontLists: typeof fontLists }>('scripts/build-bundle.mjs'));
  });

  const sets = (core: Rule[] = [], extra: Rule[] = []) => ({ 'core-data': { fontOrder: core }, 'extra-data': { fontOrder: extra } });

  it('writes each set\'s list by its image\'s names: the core\'s absolute, the add-on\'s from its top', async () => {
    const core = new Map([
      ['texlive/texmf-dist/fonts/truetype/public/dejavu/DejaVuSans.ttf', font('DejaVuSans.ttf')],
      ['texlive/texmf-dist/tex/latex/x/x.sty', Buffer.from('% not a font')],
    ]);
    const extra = new Map([['fonts/truetype/public/dejavu-serif/DejaVuSerif.ttf', font('DejaVuSerif.ttf')]]);
    const lists = await fontLists(core, extra, sets());
    assert.deepEqual(lists.problems, []);
    const coreLines = lists.core.toString('utf8').trim().split('\n');
    const extraLines = lists.extra.toString('utf8').trim().split('\n');
    assert.equal(coreLines.length, 1);
    assert.match(coreLines[0], /^\/texlive\/texmf-dist\/fonts\/truetype\/public\/dejavu\/DejaVuSans\.ttf\t0\tDejaVu Sans\t/);
    assert.equal(extraLines.length, 1);
    assert.match(extraLines[0], /^\/fonts\/truetype\/public\/dejavu-serif\/DejaVuSerif\.ttf\t0\tDejaVu Serif\t/);
    assert.deepEqual(lists.report.core, { files: 1, faces: 1 });
  });

  it('stops on a name the two sets share, which no rule of one set can decide', async () => {
    const core = new Map([['texlive/texmf-dist/fonts/truetype/a/DejaVuSans.ttf', font('DejaVuSans.ttf')]]);
    const extra = new Map([['fonts/truetype/b/DejaVuSans.ttf', font('DejaVuSans.ttf')]]);
    const lists = await fontLists(core, extra, sets());
    assert.ok(lists.problems.some((p) => /is in core \(\/texlive\/texmf-dist\/fonts\/truetype\/a\/DejaVuSans\.ttf\) and extra \(\/texmf-extra\/fonts\/truetype\/b\/DejaVuSans\.ttf\)/.test(p)), lists.problems.join('\n'));
  });

  it('stops on a name two files of one set share with no rule, and orders them by the set\'s rule', async () => {
    const a = '/texlive/texmf-dist/fonts/truetype/a/DejaVuSans.ttf';
    const b = '/texlive/texmf-dist/fonts/truetype/b/DejaVuSans.ttf';
    const core = new Map([
      [a.slice(1), font('DejaVuSans.ttf')],
      [b.slice(1), font('DejaVuSans.ttf')],
    ]);
    const without = await fontLists(core, new Map(), sets());
    assert.ok(without.problems.some((p) => /no fontOrder rule says which comes first/.test(p)), without.problems.join('\n'));
    const withRules = await fontLists(core, new Map(), sets([{ name: 'DejaVuSans', first: b }, { name: 'DejaVu Sans', first: b }, { name: 'DejaVu Sans Book', first: b }]));
    assert.deepEqual(withRules.problems, []);
    assert.ok(withRules.core.toString('utf8').startsWith(b), 'the rule\'s file comes first');
  });

  /** The font with one more table: the sfnt's directory written again with `tag` added (checksums left at 0). */
  const withTable = (sfnt: Buffer, tag: string, body: Buffer) => {
    const count = sfnt.readUInt16BE(4);
    const tables = [...Array(count).keys()].map((i) => {
      const at = 12 + 16 * i;
      const offset = sfnt.readUInt32BE(at + 8);
      return { tag: sfnt.toString('latin1', at, at + 4), data: sfnt.subarray(offset, offset + sfnt.readUInt32BE(at + 12)) };
    });
    tables.push({ tag, data: body });
    tables.sort((x, y) => (x.tag < y.tag ? -1 : 1));
    const head = Buffer.alloc(12 + 16 * tables.length);
    sfnt.copy(head, 0, 0, 4);
    head.writeUInt16BE(tables.length, 4);
    const parts: Buffer[] = [head];
    let offset = head.length;
    tables.forEach((t, i) => {
      const at = 12 + 16 * i;
      head.write(t.tag, at, 'latin1');
      head.writeUInt32BE(offset, at + 8);
      head.writeUInt32BE(t.data.length, at + 12);
      const padded = Buffer.alloc((t.data.length + 3) & ~3);
      t.data.copy(padded);
      parts.push(padded);
      offset += padded.length;
    });
    return Buffer.concat(parts);
  };
  /** An fvar table: one wght axis (100 to 900, default 400) and one named instance at 700. */
  const fvar = () => {
    const b = Buffer.alloc(16 + 20 + 8);
    b.writeUInt16BE(1, 0);
    b.writeUInt16BE(16, 4);
    b.writeUInt16BE(2, 6);
    b.writeUInt16BE(1, 8);
    b.writeUInt16BE(20, 10);
    b.writeUInt16BE(1, 12);
    b.writeUInt16BE(8, 14);
    b.write('wght', 16, 'latin1');
    b.writeInt32BE(100 * 65536, 20);
    b.writeInt32BE(400 * 65536, 24);
    b.writeInt32BE(900 * 65536, 28);
    b.writeUInt16BE(256, 34);
    b.writeUInt16BE(2, 36);
    b.writeInt32BE(700 * 65536, 40);
    return b;
  };

  it('refuses a variable font, a font collection and a web font, which the font check does not cover', async () => {
    const plain = font('DejaVuSans.ttf');
    const fl = await importScript<{ describeFile(b: Uint8Array, file: string): { faces: unknown[]; variable?: boolean } }>('scripts/lib/font-list.mjs');
    assert.equal(fl.describeFile(plain, '/a.ttf').variable, false);
    const variable = withTable(plain, 'fvar', fvar());
    assert.equal(fl.describeFile(variable, '/v.ttf').variable, true, 'the made-up font is a variable font');
    const core = new Map([
      ['texlive/texmf-dist/fonts/truetype/a/DejaVuSans.ttf', plain],
      ['texlive/texmf-dist/fonts/truetype/v/Variable.ttf', variable],
      ['texlive/texmf-dist/fonts/truetype/c/Collection.ttc', plain],
    ]);
    const extra = new Map([['fonts/opentype/w/Web.woff', plain]]);
    const lists = await fontLists(core, extra, sets());
    assert.deepEqual(lists.problems.map((p) => /^font list: (\S+): (.*?), which the font check/.exec(p)?.slice(1)), [
      ['/texlive/texmf-dist/fonts/truetype/c/Collection.ttc', 'a font collection or web font'],
      ['/texlive/texmf-dist/fonts/truetype/v/Variable.ttf', 'a variable font'],
      ['/texmf-extra/fonts/opentype/w/Web.woff', 'a font collection or web font'],
    ]);
    // The refused files are not in the lists.
    assert.equal(lists.core.toString('utf8').trim().split('\n').length, 1);
    assert.equal(lists.extra.toString('utf8'), '');
  });

  it('lists a font file the list writer cannot read, and leaves it out, as fontconfig does', async () => {
    const core = new Map([
      ['texlive/texmf-dist/fonts/truetype/a/DejaVuSans.ttf', font('DejaVuSans.ttf')],
      ['texlive/texmf-dist/fonts/opentype/b/Broken.otf', Buffer.from('not a font')],
    ]);
    const lists = await fontLists(core, new Map(), sets());
    assert.deepEqual(lists.problems, []);
    assert.deepEqual((lists.report as unknown as { dropped: { file: string }[] }).dropped.map((d) => d.file), ['/texlive/texmf-dist/fonts/opentype/b/Broken.otf']);
  });
});
