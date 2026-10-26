// M2-B: multiple root documents in one folder (src/extension/project/roots.ts), on the multi-root fixture
// test/corpus/multiroot: two roots share refs.bib and sections/shared.tex ("% !TEX root = ../paper.tex");
// appendix.tex and sections/detail.tex are found through the root that includes them.

import * as assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { findRoot, previewedTargets, type RootFs } from '../../src/extension/project/roots';
import { root } from '../support/helpers';

const fixture = path.join(root, 'test', 'corpus', 'multiroot');

/** The fixture as a project folder of its own, or placed one level down (as in the test workspace). */
function nodeRootFs(base: string): RootFs {
  const abs = (rel: string) => path.join(base, ...rel.split('/').filter(Boolean));
  return {
    readDirectory: async (rel) => readdirSync(abs(rel)).map((n) => [n, statSync(path.join(abs(rel), n)).isDirectory() ? 'dir' : 'file']),
    readFile: async (rel) => new Uint8Array(readFileSync(abs(rel))),
    exists: async (rel) => existsSync(abs(rel)),
  };
}

const text = (rel: string) => readFileSync(path.join(fixture, ...rel.split('/')), 'utf8');

describe('M2-B: multiple roots in one folder', () => {
  const fs = nodeRootFs(fixture);

  it('each file with \\documentclass is its own document', async () => {
    assert.equal(await findRoot(fs, 'paper.tex', text('paper.tex')), 'paper.tex');
    assert.equal(await findRoot(fs, 'notes.tex', text('notes.tex')), 'notes.tex');
  });

  it('"% !TEX root" is honoured, also for a file that another root includes too', async () => {
    assert.equal(await findRoot(fs, 'sections/shared.tex', text('sections/shared.tex')), 'paper.tex');
  });

  it('a file without either belongs to the root that includes it, in its folder or the folder above', async () => {
    assert.equal(await findRoot(fs, 'appendix.tex', text('appendix.tex')), 'notes.tex');
    assert.equal(await findRoot(fs, 'sections/detail.tex', text('sections/detail.tex')), 'notes.tex');
  });

  it('a root comment that leaves the project, or names a missing file, is ignored with a warning', async () => {
    const warnings: string[] = [];
    assert.equal(await findRoot(fs, 'appendix.tex', '% !TEX root = ../../outside.tex\nText.', (w) => warnings.push(w)), 'notes.tex');
    assert.equal(await findRoot(fs, 'appendix.tex', '% !TEX root = missing.tex\nText.', (w) => warnings.push(w)), 'notes.tex');
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /leaves the project folder/);
  });

  it('works with the fixture one level down in a larger project folder', async () => {
    const parent = nodeRootFs(path.dirname(fixture));
    assert.equal(await findRoot(parent, 'multiroot/sections/shared.tex', text('sections/shared.tex')), 'multiroot/paper.tex');
    assert.equal(await findRoot(parent, 'multiroot/sections/detail.tex', text('sections/detail.tex')), 'multiroot/notes.tex');
  });

  it('a file both roots read compiles only the previewed one', () => {
    const both = ['paper', 'notes'];
    const shown = (k: string) => k === 'notes';
    assert.deepEqual(previewedTargets(both, shown, undefined, []), ['notes']);
    assert.deepEqual(previewedTargets(both, () => true, undefined, []), ['paper', 'notes']); // two previews showing
    // No preview showing: the edited file's own root, else the most recently previewed document.
    assert.deepEqual(previewedTargets(both, () => false, 'paper', ['notes']), ['paper']);
    assert.deepEqual(previewedTargets(both, () => false, undefined, ['notes', 'paper']), ['notes']);
    // One candidate: always compiled.
    assert.deepEqual(previewedTargets(['paper'], () => false, undefined, []), ['paper']);
  });
});
