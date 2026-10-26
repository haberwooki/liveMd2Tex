// "New document from template" (src/extension/templates/catalog.ts; docs/DESIGN.md#help-for-new-users): every starting
// document exists and ships in the VSIX, the new folder gets a free name, a Markdown document opts in to
// typesetting, and the preset paper's folder config names the preset. test/engine/newDocuments.test.ts typesets
// each starting document as the command writes it.

import * as assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { parseFolderConfig } from '../../src/converter/config';
import { parsePresetFile, modeForFile } from '../../src/converter/preset/load';
import { folderConfigAsksForTypesetting, frontMatterAsksForTypesetting } from '../../src/extension/project/markdownOptIn';
import { freeName, TEMPLATES, templateFiles, withPreviewOptIn } from '../../src/extension/templates/catalog';
import { importScript, root } from '../support/helpers';

const read = async (from: string) => new Uint8Array(readFileSync(path.join(root, ...from.split('/'))));
const text = (data: Uint8Array) => new TextDecoder().decode(data);

describe('New document from template: the catalog', () => {
  it('has unique ids and folder names that are plain names; each main file is one of its files', () => {
    assert.equal(new Set(TEMPLATES.map((t) => t.id)).size, TEMPLATES.length);
    for (const t of TEMPLATES) {
      assert.match(t.folder, /^[a-z][a-z0-9-]*$/, t.id);
      assert.ok(t.files.some((f) => f.to === t.main), `${t.id}: the main file is not written`);
      assert.equal(new Set(t.files.map((f) => f.to.toLowerCase())).size, t.files.length, `${t.id}: two files have one name`);
      for (const f of t.files) {
        assert.ok(existsSync(path.join(root, ...f.from.split('/'))), `${t.id}: ${f.from} is missing`);
        assert.doesNotMatch(f.to, /(^|\/)\.\.(\/|$)|^\//, `${t.id}: ${f.to}`);
      }
      assert.equal(t.kind === 'tex', t.main.endsWith('.tex'), t.id);
    }
  });

  it('says which classes need the Extra Packages add-on: exactly the journal classes', () => {
    const extra = TEMPLATES.filter((t) => t.extra).map((t) => t.id);
    assert.deepEqual(extra.sort(), ['md-elsarticle', 'md-ieeetran', 'md-revtex', 'tex-elsarticle', 'tex-ieeetran', 'tex-revtex']);
    for (const t of TEMPLATES.filter((x) => x.kind === 'tex' && x.extra)) {
      assert.match(t.detail, /Extra Packages/, t.id);
    }
  });

  it('cites only keys the bibliography has', async () => {
    const bib = text(await read('templates/markdown/references.bib'));
    const keys = new Set([...bib.matchAll(/@\w+\{([^,\s]+),/g)].map((m) => m[1]));
    for (const t of TEMPLATES) {
      const main = text(await read(t.files.find((f) => f.to === t.main)?.from ?? ''));
      const cited = [...main.matchAll(/\\cite\{([^}]+)\}/g), ...main.matchAll(/\[(@[^\]]+)\]/g)]
        .flatMap((m) => m[1].split(/[,;]/))
        .map((k) => k.trim().replace(/^@/, ''))
        .filter((k) => /^[a-z]+\d{4}$/.test(k));
      // A document with a bibliography cites from it (the preset paper cites as [Surname Year]).
      const hasBib = t.files.some((f) => f.to.endsWith('.bib'));
      assert.equal(cited.length > 0 || t.id === 'md-preset-paper', hasBib, `${t.id}: citations and bibliography do not go together`);
      for (const k of cited) {
        assert.ok(keys.has(k), `${t.id} cites ${k}, which references.bib does not have`);
      }
    }
  });

  it('makes each Markdown document ask to be typeset, by its front matter or its folder config', async () => {
    for (const t of TEMPLATES.filter((x) => x.kind === 'markdown')) {
      const files = await templateFiles(t, read);
      const main = files.find((f) => f.to === t.main);
      assert.ok(main, t.id);
      const config = files.find((f) => f.to === '.latexpreview.json');
      const asks = frontMatterAsksForTypesetting(text(main.data)) || (config !== undefined && folderConfigAsksForTypesetting(text(config.data)));
      assert.ok(asks, `${t.id}: the new document would not be typeset`);
    }
    for (const t of TEMPLATES.filter((x) => x.kind === 'tex')) {
      assert.deepEqual((await templateFiles(t, read)).map((f) => f.to).sort(), t.files.map((f) => f.to).sort(), t.id);
    }
  });

  it('gives the preset paper a folder config that names the preset, and a mode for paper.md', async () => {
    const t = TEMPLATES.find((x) => x.id === 'md-preset-paper');
    assert.ok(t);
    const files = await templateFiles(t, read);
    const config = files.find((f) => f.to === '.latexpreview.json');
    assert.ok(config);
    const parsed = parseFolderConfig(text(config.data));
    assert.deepEqual(parsed.problems, []);
    const presetRel = parsed.config.markdown.preset ?? '';
    const preset = files.find((f) => f.to === presetRel);
    assert.ok(preset, `the preset ${presetRel} is not written`);
    const presetFile = parsePresetFile(text(preset.data));
    assert.ok(presetFile.preset, presetFile.problems.join('; '));
    assert.equal(modeForFile(presetFile.preset, t.main), 'paper');
    // Every preamble the preset names is written beside it.
    const folder = path.posix.dirname(presetRel);
    for (const spec of [presetFile.preset.defaults ?? {}, ...Object.values(presetFile.preset.modes)]) {
      for (const name of [spec.preambleFile, spec.xetexPreambleFile].filter((n): n is string => typeof n === 'string')) {
        assert.ok(files.some((f) => f.to === `${folder}/${name}`), `${name} is not written`);
      }
    }
    // The paper's appendix (methods.md) is written beside the paper.
    assert.ok(files.some((f) => f.to === 'methods.md'));
  });

  it('adds the opt-in to front matter, or adds front matter, keeping the line ends', () => {
    assert.equal(withPreviewOptIn('---\ntitle: A\n---\n\nText\n'), '---\nlatex-preview: true\ntitle: A\n---\n\nText\n');
    assert.equal(withPreviewOptIn('---\r\ntitle: A\r\n---\r\n'), '---\r\nlatex-preview: true\r\ntitle: A\r\n---\r\n');
    assert.equal(withPreviewOptIn('# Notes\n'), '---\nlatex-preview: true\n---\n\n# Notes\n');
    assert.ok(frontMatterAsksForTypesetting(withPreviewOptIn('# Notes\n')));
  });

  it('never reuses a name: base, base-2, base-3, compared without case', () => {
    assert.equal(freeName('paper', []), 'paper');
    assert.equal(freeName('paper', ['Paper']), 'paper-2');
    assert.equal(freeName('paper', ['paper', 'paper-2', 'PAPER-3']), 'paper-4');
    assert.equal(freeName('paper', ['paper-2']), 'paper');
  });

  it('ships every template file in the VSIX with the CC0 notices, and no other file of templates/', async () => {
    type Vsce = { listFiles(o: { cwd: string; packageManager: number }): Promise<string[]>; PackageManager: { None: number } };
    const vsce = await importScript<Vsce>('node_modules/@vscode/vsce/out/api.js');
    const listed = new Set((await vsce.listFiles({ cwd: root, packageManager: vsce.PackageManager.None })).map((f) => f.replace(/\\/g, '/')));
    const needed = new Set([...TEMPLATES.flatMap((t) => t.files.map((f) => f.from)), 'templates/LICENSE.md', 'examples/presets/LICENSE.md']);
    for (const f of needed) {
      assert.ok(listed.has(f), `${f} is not in the VSIX (.vscodeignore)`);
    }
    assert.deepEqual([...listed].filter((f) => f.startsWith('templates/') && !needed.has(f)), []);
  });

  it("writes only CC0 files into the user's folder: an SPDX CC0 line where the format has comments, no GPL", async () => {
    for (const t of TEMPLATES) {
      for (const f of await templateFiles(t, read)) {
        const body = text(f.data);
        assert.doesNotMatch(body, /\bGPL\b|GNU General Public/, `${t.id}: ${f.to} names the GPL`);
        if (/\.(tex|bib|md)$/.test(f.to)) {
          assert.ok(body.includes('SPDX-License-Identifier: CC0-1.0'), `${t.id}: ${f.to} has no SPDX CC0 line`);
        } else if (f.to.endsWith('preset.json')) {
          assert.match(body, /CC0 1\.0/, `${t.id}: ${f.to} does not say CC0`);
        }
      }
    }
    for (const notice of ['templates/LICENSE.md', 'examples/presets/LICENSE.md']) {
      assert.match(text(await read(notice)), /SPDX-License-Identifier: CC0-1\.0/);
    }
  });
});
