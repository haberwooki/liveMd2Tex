// The compile worker's set-up rules (src/engine-host/engine/layout.ts), and the engine pin against its build record.

import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkEnvOverrides, ENV_OVERRIDES, FONT_LIST_IN_IMAGE, fontListText, HEADER_BYTES, headerProblem } from '../../src/engine-host/engine/layout';
import { bundledEngineAssets } from '../../src/extension/engine/engineService';
import { root } from '../support/helpers';

describe('the compile worker\'s set-up (layout.ts)', () => {
  it('the header check passes memory of exactly 64 MiB and fails a grown or a smaller memory with a plain message', () => {
    assert.equal(HEADER_BYTES, 64 * 1024 * 1024);
    assert.doesNotThrow(() => headerProblem(HEADER_BYTES));
    assert.throws(() => headerProblem(HEADER_BYTES + 65536), /cannot start: its memory is 67174400 bytes before the first program, not 67108864/);
    assert.throws(() => headerProblem(HEADER_BYTES / 2), /reinstall the extension/);
  });

  it('the font list joins the images\' own lists in mount order, each path behind its image\'s mount root', () => {
    const core = '/texlive/texmf-dist/fonts/opentype/a/A.otf\t0\tA\tRegular\tA Regular\tA-Regular\t80\t100\t0\n';
    const extra = '/fonts/truetype/b/B.ttf\t0\tB\tBold\tB Bold\tB-Bold\t200\t100\t0\r\n\n';
    assert.equal(
      fontListText([
        { root: '', text: core },
        { root: '/texmf-extra', text: extra },
      ]),
      '/texlive/texmf-dist/fonts/opentype/a/A.otf\t0\tA\tRegular\tA Regular\tA-Regular\t80\t100\t0\n/texmf-extra/fonts/truetype/b/B.ttf\t0\tB\tBold\tB Bold\tB-Bold\t200\t100\t0\n',
    );
    assert.equal(fontListText([]), '');
    assert.equal(fontListText([{ root: '', text: '\n' }]), '');
    // A comment line keeps its "#" first, so it stays a comment for the stand-in.
    assert.equal(fontListText([{ root: '/texmf-extra', text: '# a note\n/fonts/x.ttf\t0\tX\n' }]), '# a note\n/texmf-extra/fonts/x.ttf\t0\tX\n');
    // Where the data builder puts each set's list, by the image's file names.
    assert.deepEqual(FONT_LIST_IN_IMAGE, { core: '/texlive/texmf-dist/fonts/xetex-fonts.tsv', extra: '/fonts/xetex-fonts.tsv' });
  });

  it('the environment override takes only the font list check and the fixed dates, never shell escape', () => {
    assert.deepEqual([...ENV_OVERRIDES].sort(), ['FORCE_SOURCE_DATE', 'LIVEMD2TEX_FONT_LIST_CHECK', 'SOURCE_DATE_EPOCH']);
    assert.doesNotThrow(() => checkEnvOverrides(undefined));
    assert.doesNotThrow(() => checkEnvOverrides({ LIVEMD2TEX_FONT_LIST_CHECK: '1', SOURCE_DATE_EPOCH: '0', FORCE_SOURCE_DATE: '1' }));
    for (const key of ['shell_escape', 'TEXMFHOME', 'TEXMFCNF', 'MKTEXPK', 'openout_any']) {
      assert.throws(() => checkEnvOverrides({ [key]: 'x' }), new RegExp(`cannot be set for ${key}`), key);
    }
  });

  it("the extension's own engine assets set no environment override", () => {
    const ext = mkdtempSync(path.join(os.tmpdir(), 'livemd2tex-assets-'));
    try {
      const put = (rel: string, text: string) => {
        mkdirSync(path.dirname(path.join(ext, rel)), { recursive: true });
        writeFileSync(path.join(ext, rel), text);
      };
      for (const rel of ['dist/engine/engine.js', 'dist/engine/engine.wasm', 'dist/engine/texmf-override.cnf', 'dist/data/core.data', 'dist/data/core.index.json']) put(rel, 'x');
      put('dist/data/manifest.json', JSON.stringify({ image: { file: 'core.data', index: 'core.index.json' } }));
      const assets = bundledEngineAssets(ext);
      assert.ok(assets, 'the assets are found');
      assert.equal(assets.env, undefined);
    } finally {
      rmSync(ext, { recursive: true, force: true });
    }
  });

  it('the pinned engine files are the ones engine/engine-build.json records', () => {
    type Pinned = { name: string; size: number; sha256: string; url: string };
    const pins = JSON.parse(readFileSync(path.join(root, 'engine', 'pins.json'), 'utf8')) as { sources: { id: string; tag: string; commit: string; files: Pinned[] }[] };
    const engine = pins.sources.find((s) => s.id === 'livemd2tex-engine');
    assert.ok(engine, 'engine/pins.json pins no livemd2tex-engine source');
    const manifest = JSON.parse(readFileSync(path.join(root, 'engine', 'engine-build.json'), 'utf8')) as { outputs: Record<'wasm' | 'glue', { name: string; size: number; sha256: string }>; build: { scripts: { commit: string } } };
    for (const kind of ['wasm', 'glue'] as const) {
      const out = manifest.outputs[kind];
      const pin: Pinned | undefined = engine.files.find((f) => f.name === out.name);
      assert.ok(pin, `no pin for ${out.name}`);
      assert.equal(pin.sha256, out.sha256, `${out.name}: the pin's SHA-256 is not the build record's`);
      assert.equal(pin.size, out.size);
      assert.ok(pin.url.endsWith(`/releases/download/${engine.tag}/${out.name}`), pin.url);
    }
    assert.equal(manifest.build.scripts.commit, engine.commit, 'the pin names another commit than the build record');
    const record: Pinned | undefined = engine.files.find((f) => f.name === 'engine-build.json');
    assert.ok(record, 'the build record itself is pinned too');
    assert.equal(createHash('sha256').update(readFileSync(path.join(root, 'engine', 'engine-build.json'))).digest('hex'), record.sha256, 'engine/engine-build.json is not the pinned record');
  });
});
