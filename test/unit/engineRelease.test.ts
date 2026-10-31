// The engine release and the comparison of two builds (docs/DEVELOPING.md, "The TeX engine: our own build"):
// which manifest fields the comparison may ignore, the release's notice set and NOTICE, and the checks of the
// build's artifacts before a draft is made.

import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { importScript } from '../support/helpers';

interface Compare {
  IGNORABLE: { field: string; why: string }[];
  manifestDifferences(a: unknown, b: unknown): { counted: { field: string }[]; ignored: { field: string }[] };
}
interface Component {
  id: string;
  name: string;
  notices: string[];
}
interface Next {
  components: Component[];
  files: Record<string, { sha256: string; release?: unknown }>;
  build: { texLive: { commit: string }; emscripten: { commit: string; release: string } };
  sources: { name: string; commit: string }[];
}
interface Notices {
  releaseNotice(m: Next): string;
  releaseAssetName(p: string): string;
}
interface Release {
  TAG: RegExp;
  loadNext(): Next;
  artifactProblems(manifest: unknown, outputs: { wasm: Buffer; glue: Buffer }, next: Next, pins: unknown, commit: string, tree: string): string[];
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('the engine release and the comparison of two builds', () => {
  let cmp: Compare;
  let notices: Notices;
  let rel: Release;
  before(async () => {
    cmp = await importScript<Compare>('scripts/engine-compare.mjs');
    notices = await importScript<Notices>('scripts/lib/engine-notices.mjs');
    rel = await importScript<Release>('scripts/engine-release.mjs');
  });

  it('ignores only the fields that name the machine; the scripts\' commit counts', () => {
    const base = { outputs: { wasm: { sha256: 'w' } }, build: { scripts: { commit: 'c1', treeSha256: 't' } }, toolchain: { emcc: 'emcc 6.0.13', machine: { os: 'Ubuntu 26.04.1 LTS', cpus: 16 }, host: { awk: { version: 'GNU Awk 5.3.2' } }, runnerImage: null } };
    const ci = { ...base, toolchain: { ...base.toolchain, machine: { os: 'Ubuntu 26.04 LTS', cpus: 4 }, host: { awk: { version: 'GNU Awk 5.3.1' } }, runnerImage: { os: 'ubuntu26', version: '20261026.180.1' } } };
    const d = cmp.manifestDifferences(base, ci);
    assert.deepEqual(d.counted, []);
    assert.deepEqual(d.ignored.map((x) => x.field).sort(), ['toolchain.host.awk.version', 'toolchain.machine.cpus', 'toolchain.machine.os', 'toolchain.runnerImage']);
    // The commit counts, whether one side lacks it or the two differ.
    assert.deepEqual(cmp.manifestDifferences({ ...base, build: { scripts: { commit: null, treeSha256: 't' } } }, base).counted.map((x) => x.field), ['build.scripts.commit']);
    assert.deepEqual(cmp.manifestDifferences({ ...base, build: { scripts: { commit: 'c2', treeSha256: 't' } } }, base).counted.map((x) => x.field), ['build.scripts.commit']);
    // Anything else counts: the compiler, the outputs, the tree hash.
    assert.deepEqual(cmp.manifestDifferences({ ...base, toolchain: { ...base.toolchain, emcc: 'emcc 6.0.14' } }, base).counted.map((x) => x.field), ['toolchain.emcc']);
    assert.ok(cmp.IGNORABLE.every((r) => r.why.length > 0));
  });

  it('the release\'s notice files have distinct names, and NOTICE names every part with its files', () => {
    const next = rel.loadNext();
    const names = Object.keys(next.files).map(notices.releaseAssetName);
    assert.equal(new Set(names).size, names.length, names.join(' '));
    assert.equal(notices.releaseAssetName('LICENSE'), 'GPL-3.0.txt');
    const text = notices.releaseNotice(next);
    for (const c of next.components) {
      assert.ok(text.includes(c.name), c.id);
      for (const n of c.notices) assert.ok(text.includes(notices.releaseAssetName(n)), `${c.id}: ${n}`);
      for (const n of c.notices) assert.ok(n in next.files || n === 'LICENSE' || /^LICENSES\/[^/]+\.txt$/.test(n), `${c.id}: ${n} is pinned or a licence text`);
    }
    // musl's COPYRIGHT of 6.0.13 comes from Emscripten's archive while LICENSES/engine holds today's engine's copy.
    assert.ok(next.files['LICENSES/engine/musl-COPYRIGHT.txt'].release);
    assert.match(text, /musl-file-notices\.txt/);
  });

  it('attaches our scripts only when their archive gives the manifest\'s tree hash and holds LICENSE', async () => {
    const { treeOfFiles } = await importScript<{ treeOfFiles(f: [string, Buffer][]): { treeSha256: string } }>('engine/build/tools/scripts-tree.mjs');
    const { scriptsArchiveProblems } = await importScript<{ scriptsArchiveProblems(b: Buffer, tree: string): string[] }>('scripts/engine-release.mjs');
    // A plain ustar archive, as git archive writes one, below one top folder.
    const tar = (files: [string, string][]) => {
      const blocks: Buffer[] = [];
      for (const [name, text] of files) {
        const body = Buffer.from(text);
        const h = Buffer.alloc(512);
        h.write(`top/${name}`, 0, 'utf8');
        h.write('0000644\0', 100);
        h.write('0000000\0', 108);
        h.write('0000000\0', 116);
        h.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
        h.write('00000000000\0', 136);
        h.write('        ', 148);
        h.write('0', 156);
        h.write('ustar\0', 257);
        h.write('00', 263);
        let sum = 0;
        for (const b of h) sum += b;
        h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
        blocks.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
      }
      blocks.push(Buffer.alloc(1024));
      return gzipSync(Buffer.concat(blocks));
    };
    const scripts: [string, string][] = [['engine/build/build.sh', '#!/bin/bash\n'], ['engine/build/tools/run.mjs', '// run\n'], ['engine/engine-build-pins.json', '{}\n']];
    const tree = treeOfFiles(scripts.map(([n, t]) => [n, Buffer.from(t)])).treeSha256;
    assert.deepEqual(scriptsArchiveProblems(tar([...scripts, ['LICENSE', 'GPL\n']]), tree), []);
    assert.equal(scriptsArchiveProblems(tar(scripts), tree).length, 1, 'no LICENSE');
    assert.match(scriptsArchiveProblems(tar([...scripts.slice(1), ['LICENSE', 'GPL\n']]), tree)[0], /tree hash/);
    assert.match(scriptsArchiveProblems(tar([...scripts, ['LICENSE', 'GPL\n'], ['src/x.ts', 'x']]), tree)[0], /other files/);
  });

  it('checks the artifacts against the manifest, the pins and the checkout before a draft is made', () => {
    const next = rel.loadNext();
    const wasm = Buffer.from('wasm');
    const glue = Buffer.from('glue');
    const pins = { texLive: { commit: next.build.texLive.commit }, emscripten: { commit: next.build.emscripten.commit } };
    const manifest = {
      outputs: { wasm: { sha256: sha(wasm) }, glue: { sha256: sha(glue) } },
      inputs: { texLive: { commit: next.build.texLive.commit }, emscripten: { commit: next.build.emscripten.commit } },
      build: { scripts: { commit: 'c0ffee', treeSha256: 'tree' } },
      layout: { staticEndBelowHeader: true },
      linkMap: { pass: true },
      muslNotices: { pass: true },
    };
    assert.deepEqual(rel.artifactProblems(manifest, { wasm, glue }, next, pins, 'c0ffee', 'tree'), []);
    const bad = rel.artifactProblems({ ...manifest, build: { scripts: { commit: 'other', treeSha256: 'old' } } }, { wasm: Buffer.from('x'), glue }, next, pins, 'c0ffee', 'tree');
    assert.equal(bad.length, 3, bad.join('\n'));
    assert.ok(rel.TAG.test('engine-6a30018-1'));
    assert.ok(!rel.TAG.test('engine-6a30018-0') && !rel.TAG.test('engine-6a30018-1\nX=1') && !rel.TAG.test('v1.0.0'));
  });
});
