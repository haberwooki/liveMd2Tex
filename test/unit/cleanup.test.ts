// B1's cleanup command for a development machine (scripts/clean-interim-data.mjs; docs/DESIGN.md#engine-and-data), on a made-up
// folder layout: it lists the interim image and the pinned CTAN files, deletes nothing without --yes, refuses
// while dist/data does not hold B1's core-data, and keeps the engine itself.

import * as assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { importScript, root } from '../support/helpers';

interface Cleanup {
  cleanupList(root: string, assets: string): { path: string; bytes: number; why: string }[];
  main(argv: string[], root: string, assets: string): number;
}

describe('B1 cleanup command (scripts/clean-interim-data.mjs)', () => {
  let c: Cleanup;
  let tmp: string;
  let fakeRoot: string;
  let assets: string;
  let log: string[];
  const quiet = <T>(fn: () => T): T => {
    const [l, e] = [console.log, console.error];
    console.log = (m: string) => log.push(m);
    console.error = (m: string) => log.push(m);
    try {
      return fn();
    } finally {
      [console.log, console.error] = [l, e];
    }
  };

  before(async () => {
    c = await importScript<Cleanup>('scripts/clean-interim-data.mjs');
  });
  beforeEach(() => {
    log = [];
    tmp = mkdtempSync(path.join(os.tmpdir(), 'livemd2tex-cleanup-'));
    fakeRoot = path.join(tmp, 'code');
    assets = path.join(tmp, 'engine_assets');
    mkdirSync(path.join(fakeRoot, 'engine'), { recursive: true });
    cpSync(path.join(root, 'engine', 'pins.json'), path.join(fakeRoot, 'engine', 'pins.json'));
    const tl = path.join(assets, 'texlyre-busytex-build-46ebb62');
    mkdirSync(tl, { recursive: true });
    writeFileSync(path.join(tl, 'texlive-extra.data'), Buffer.alloc(1000));
    writeFileSync(path.join(tl, 'texlive-extra.js'), 'loader');
    writeFileSync(path.join(tl, 'busytex.wasm'), Buffer.alloc(10));
    mkdirSync(path.join(assets, 'ctan-revtex'), { recursive: true });
    writeFileSync(path.join(assets, 'ctan-revtex', 'revtex.tds.zip'), Buffer.alloc(50));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('lists the interim image and the CTAN files, and keeps the engine', () => {
    const list = c.cleanupList(fakeRoot, assets).map((x) => path.relative(assets, x.path).replace(/\\/g, '/'));
    assert.deepEqual(list, ['texlyre-busytex-build-46ebb62/texlive-extra.data', 'texlyre-busytex-build-46ebb62/texlive-extra.js', 'ctan-revtex']);
  });

  it('deletes nothing without --yes, and refuses until dist/data holds core-data', () => {
    assert.equal(quiet(() => c.main([], fakeRoot, assets)), 0);
    assert.ok(existsSync(path.join(assets, 'ctan-revtex')));
    assert.equal(quiet(() => c.main(['--yes'], fakeRoot, assets)), 1);
    assert.match(log.join('\n'), /Refused/);
    assert.ok(existsSync(path.join(assets, 'texlyre-busytex-build-46ebb62', 'texlive-extra.data')));
    mkdirSync(path.join(fakeRoot, 'dist', 'data'), { recursive: true });
    writeFileSync(path.join(fakeRoot, 'dist', 'data', 'manifest.json'), JSON.stringify({ format: 1, set: 'core-data' }));
    assert.equal(quiet(() => c.main(['--yes'], fakeRoot, assets)), 0);
    assert.ok(!existsSync(path.join(assets, 'texlyre-busytex-build-46ebb62', 'texlive-extra.data')));
    assert.ok(!existsSync(path.join(assets, 'ctan-revtex')));
    assert.ok(existsSync(path.join(assets, 'texlyre-busytex-build-46ebb62', 'busytex.wasm')), 'the engine stays');
  });
});
