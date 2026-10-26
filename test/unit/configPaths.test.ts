// Build gate 1, G1S-03 and the config part of G1E-04: the files a folder config or a preset names are read only
// from inside the project folder, links included (src/extension/markdown/confinePaths.ts). These tests would have
// caught the finding: "..", absolute, drive, UNC and "~" paths, URIs, and a link (a junction on Windows, a
// symbolic link elsewhere) that leads out of the folder.

import * as assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { confinedRelative, realPathStaysInside } from '../../src/extension/markdown/confinePaths';

describe('build gate 1 (G1S-03, G1E-04): config and preset paths stay in the project folder', () => {
  it('accepts paths inside the project folder, from the folder that names them', () => {
    assert.equal(confinedRelative('', 'presets/lab/preset.json'), 'presets/lab/preset.json');
    assert.equal(confinedRelative('notes', 'appendix.md'), 'notes/appendix.md');
    assert.equal(confinedRelative('notes/sub', '../shared/methods.md'), 'notes/shared/methods.md');
    assert.equal(confinedRelative('presets', 'a/../b.tex'), 'presets/b.tex');
    assert.equal(confinedRelative('presets', 'preamble\\paper.tex'), 'presets/preamble/paper.tex');
  });

  it('refuses "..", absolute, drive, UNC and "~" paths and URIs', () => {
    for (const [base, name] of [
      ['', '../outside/preset.json'],
      ['notes', '../../../../.ssh/id_rsa'],
      ['notes', '..'],
      ['', '/etc/passwd'],
      ['', 'C:\\Windows\\win.ini'],
      ['', 'c:/Users/someone/secret.md'],
      ['', '\\\\server\\share\\preset.json'],
      ['', '//server/share/preset.json'],
      ['', '~/.ssh/id_rsa'],
      ['', 'file:///etc/passwd'],
      ['', 'vscode-userdata:/settings.json'],
      ['', 'a\0b'],
      ['', ''],
    ]) {
      assert.equal(confinedRelative(base, name), undefined, `${base} + ${JSON.stringify(name)}`);
    }
  });

  it('compares real paths as the project model does (project/realPath.ts)', async () => {
    // A stand-in for fs.realpath: a link inside the project that resolves outside it, and one that stays inside.
    const project = path.resolve('/work/proj');
    const links: Record<string, string> = {
      [path.join(project, 'out', 'p.json')]: path.resolve('/work/proj-other/p.json'),
      [path.join(project, 'in', 'p.json')]: path.join(project, 'presets', 'p.json'),
    };
    const realpath = async (p: string) => links[p] ?? p;
    assert.equal(await realPathStaysInside(project, path.join(project, 'presets', 'p.json'), realpath), true);
    assert.equal(await realPathStaysInside(project, path.join(project, 'in', 'p.json'), realpath), true);
    assert.equal(await realPathStaysInside(project, path.join(project, 'out', 'p.json'), realpath), false);
    const missing = async (p: string) => {
      if (p !== project) {
        throw new Error('ENOENT');
      }
      return p;
    };
    assert.equal(await realPathStaysInside(project, path.join(project, 'none.md'), missing), true); // nothing to read
  });

  it('refuses a file reached through a link that leads out of the folder (a junction, and a symbolic link where allowed)', async function () {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'livemd2tex-confine-'));
    try {
      const project = path.join(tmp, 'project');
      const outside = path.join(tmp, 'outside');
      mkdirSync(path.join(project, 'presets'), { recursive: true });
      mkdirSync(outside);
      writeFileSync(path.join(outside, 'secret.md'), 'secret');
      writeFileSync(path.join(project, 'presets', 'preset.json'), '{}');
      // A linked folder: a junction on Windows (no rights needed), a directory link elsewhere.
      symlinkSync(outside, path.join(project, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
      assert.equal(await realPathStaysInside(project, path.join(project, 'presets', 'preset.json')), true);
      assert.equal(await realPathStaysInside(project, path.join(project, 'linked', 'secret.md')), false);
      assert.equal(await realPathStaysInside(project, path.join(project, 'missing.md')), true); // nothing to read
      // A linked file: Windows allows it only with Developer Mode or administrator rights.
      try {
        symlinkSync(path.join(outside, 'secret.md'), path.join(project, 'notes.md'), 'file');
      } catch {
        return;
      }
      assert.equal(await realPathStaysInside(project, path.join(project, 'notes.md')), false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
