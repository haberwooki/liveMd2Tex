// Writes into a project folder never follow a link out of it (build gate 2, G2S-02): the check behind
// src/extension/project/confinedWrite.ts, which "Add a package from a file" (project copies), Export LaTeX,
// "Create folder config" and the PDF written on save all use. A Windows junction is the fixture on the laptop; the
// file-link case runs where the system lets the test make one (CI on Linux and macOS).

import * as assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeTargetProblem } from '../../src/extension/project/realPath';

describe('build gate 2, G2S-02: writes into the project folder stay in it', () => {
  let tmp = '';
  let project = '';
  let outside = '';
  before(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'livemd2tex-writes-'));
    outside = path.join(tmp, 'outside');
    project = path.join(tmp, 'project');
    mkdirSync(outside);
    mkdirSync(project);
    writeFileSync(path.join(outside, 'precious.txt'), 'the user\'s own file\n');
    writeFileSync(path.join(project, 'plain.sty'), '% a plain file\n');
    // A junction needs no privilege on Windows; elsewhere this is a directory symbolic link.
    symlinkSync(outside, path.join(project, 'linkdir'), 'junction');
  });
  after(() => rmSync(tmp, { recursive: true, force: true }));

  it('a target in a folder reached through a junction is refused, existing or not', async () => {
    assert.match((await writeTargetProblem(project, path.join(project, 'linkdir', 'precious.txt'))) ?? '', /link that leads outside/);
    assert.match((await writeTargetProblem(project, path.join(project, 'linkdir', 'new.sty'))) ?? '', /link that leads outside/);
    assert.match((await writeTargetProblem(project, path.join(project, 'linkdir', 'deeper', 'new.sty'))) ?? '', /link that leads outside/);
  });

  it('a plain target, a new file and a new folder inside the project may be written', async () => {
    assert.equal(await writeTargetProblem(project, path.join(project, 'plain.sty')), undefined);
    assert.equal(await writeTargetProblem(project, path.join(project, 'new.sty')), undefined);
    assert.equal(await writeTargetProblem(project, path.join(project, 'sub', 'dir', 'new.cls')), undefined);
  });

  it('a target outside the folder, the folder itself and a folder as target are refused', async () => {
    assert.match((await writeTargetProblem(project, path.join(outside, 'x.sty'))) ?? '', /outside the project folder/);
    assert.match((await writeTargetProblem(project, project)) ?? '', /outside the project folder/);
    mkdirSync(path.join(project, 'adir'));
    assert.match((await writeTargetProblem(project, path.join(project, 'adir'))) ?? '', /not a file/);
  });

  it('a junction whose target is gone gives a plain reason, not an error (G2R-04)', async () => {
    const gone = path.join(tmp, 'gone');
    mkdirSync(gone);
    symlinkSync(gone, path.join(project, 'dangling'), 'junction');
    rmSync(gone, { recursive: true });
    assert.match((await writeTargetProblem(project, path.join(project, 'dangling', 'x.sty'))) ?? '', /broken link/);
  });

  it('a target that is itself a file link is refused (where the system allows making one)', async function () {
    try {
      symlinkSync(path.join(outside, 'precious.txt'), path.join(project, 'foo.sty'), 'file');
    } catch {
      // Windows without Developer Mode cannot make file links; CI on Linux and macOS runs this case.
      this.skip();
    }
    assert.match((await writeTargetProblem(project, path.join(project, 'foo.sty'))) ?? '', /it is a link/);
  });
});
