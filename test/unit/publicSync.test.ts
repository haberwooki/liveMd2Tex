// The public sync (scripts/public-sync.mjs; G0 onward, gate G0-sync): what it decides for each state of the public
// clone; the checks that stop it before anything is written (a message from the development history or naming it,
// private files by name, private prose that is not on the reviewed allow-list, private texts that cannot be read);
// and the path check every public-history script uses (scripts/lib/paths.mjs). The script itself runs git, so its
// full run is checked by hand on a scratch clone.

import * as assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { importScript, root } from '../support/helpers';

interface Plan {
  action: 'nothing' | 'prepared' | 'stop' | 'reset' | 'commit';
  reason?: string;
}
interface PublicSync {
  planSync(state: { laptopTree: string; originSha: string; originTree: string; headSha: string; headTree: string; headDescends: boolean }, replaceUnpushed?: boolean): Plan;
  main(argv: string[]): number;
}
interface History {
  messageProblems(message: string, branches: string[]): string[];
  blockingRuns(files: { file: string; content: Buffer }[], privateRuns: Set<string>, allowed: Set<string>): { file: string; runs: string[] }[];
  loadPrivateTexts(root: string): { texts: string[]; problems: string[] };
  isPrivatePath(file: string): boolean;
  runs(text: string): Set<string>;
}
interface Paths {
  isOutside(root: string, p: string): boolean;
}

/** A made-up paragraph in the style of a private manuscript (the test's own words, not a real document). */
const PARAGRAPH =
  'We measured the formation energies of four hundred ternary alloys with the cluster expansion and found that the ' +
  'ordered phases near the equiatomic composition are stabilised by the short range order of the second shell.';

describe('public sync script (G0)', () => {
  let sync: PublicSync;
  let h: History;
  let paths: Paths;
  let errors: string[];
  const quiet = <T>(fn: () => T): T => {
    const original = console.error;
    console.error = (m: string) => errors.push(m);
    try {
      return fn();
    } finally {
      console.error = original;
    }
  };
  before(async () => {
    sync = await importScript<PublicSync>('scripts/public-sync.mjs');
    h = await importScript<History>('scripts/lib/public-history.mjs');
    paths = await importScript<Paths>('scripts/lib/paths.mjs');
  });
  beforeEach(() => {
    errors = [];
  });

  const clean = { laptopTree: 'T2', originSha: 'O', originTree: 'T1', headSha: 'O', headTree: 'T1', headDescends: true };

  it('commits when the public tree differs, does nothing when it is the same, and is idempotent', () => {
    assert.equal(sync.planSync(clean).action, 'commit');
    assert.equal(sync.planSync({ ...clean, laptopTree: 'T1' }).action, 'nothing');
    assert.equal(sync.planSync({ ...clean, headSha: 'H', headTree: 'T2' }).action, 'prepared');
  });

  it('stops at another unpushed commit unless asked to replace it, and always when main left origin/main', () => {
    const waiting = { ...clean, headSha: 'H', headTree: 'T3' };
    assert.equal(sync.planSync(waiting).action, 'stop');
    assert.equal(sync.planSync(waiting, true).action, 'commit');
    assert.equal(sync.planSync({ ...waiting, headDescends: false }, true).action, 'stop');
    assert.equal(sync.planSync({ ...waiting, laptopTree: 'T1' }, true).action, 'reset');
  });

  it('refuses to run without a message written for it (GS-02)', () => {
    assert.equal(
      quiet(() => sync.main(['--public', path.join(root, '..', 'elsewhere')])),
      2,
    );
    assert.match(errors[0], /Give the public commit message/);
  });

  it('refuses --no-private-check where the private markers file is (GS-01)', function () {
    const here = [path.join(root, '.private-markers.json'), path.join(root, '..', '.private-markers.json')];
    if (!here.some((f) => existsSync(f))) {
      this.skip();
    }
    assert.equal(quiet(() => sync.main(['--message', 'liveMd2Tex: update', '--no-private-check'])), 2);
    assert.match(errors[0], /--no-private-check is refused/);
  });

  it('refuses a public clone inside this repository', () => {
    assert.equal(quiet(() => sync.main(['--message', 'liveMd2Tex: update', '--public', path.join(root, 'inside')])), 2);
    assert.match(errors.at(-1) ?? '', /outside this one/);
  });

  it('stops a message with a branch name, a commit hash, or a word about the private material (GS-02)', () => {
    const branches = ['main', 'm6', 'public-b', 'fix/g1-a', 'g0-sync'];
    assert.deepEqual(h.messageProblems('liveMd2Tex: the bundle builder, and fixes for Linux and Windows CI', branches), []);
    assert.deepEqual(h.messageProblems('liveMd2Tex: main is up to date', branches), []);
    const bad = h.messageProblems('Merge public-b into m6 (5e16045): private tests in an overlay, from the laptop worklog; fix/g1-a', branches);
    for (const want of ['"private"', '"overlay"', '"laptop"', '"worklog"', '"5e16045"', '"public-b"', '"m6"', '"fix/g1-a"']) {
      assert.ok(bad.some((p) => p.includes(want)), `not caught: ${want} (${bad.join('; ')})`);
    }
    assert.deepEqual(h.messageProblems('m6x and xm6 are not the branch', ['m6']), []);
  });

  it('stops a changed file that shares private prose; the allow-list lets generic lines through (GS-01)', () => {
    const privateRuns = h.runs(`\\documentclass[11pt]{article}\n\\usepackage[T1]{fontenc}\n\\usepackage[utf8]{inputenc}\n\\usepackage{graphicx}\n${PARAGRAPH}`);
    const generic = { file: 'examples/letter.tex', content: Buffer.from('\\documentclass[11pt]{article}\n\\usepackage[T1]{fontenc}\n\\usepackage[utf8]{inputenc}\n\\usepackage{graphicx}\n') };
    const copied = { file: 'docs/notes.md', content: Buffer.from(`Some notes.\n\n${PARAGRAPH}\n`) };
    const binary = { file: 'figs/plot.png', content: Buffer.from(PARAGRAPH) };
    const allowed = new Set([...h.runs(generic.content.toString())]);
    assert.deepEqual(h.blockingRuns([generic, binary], privateRuns, allowed), []);
    const stop = h.blockingRuns([generic, copied], privateRuns, allowed);
    assert.equal(stop.length, 1);
    assert.equal(stop[0].file, 'docs/notes.md');
    assert.ok(stop[0].runs.length >= 20, `only ${stop[0].runs.length} runs`);
    // Without the allow-list the generic lines stop it too.
    assert.equal(h.blockingRuns([generic], privateRuns, new Set()).length, 1);
  });

  it('cannot compare without the private texts: no config, no folder, no overlay is a problem, not a skip (GS-01)', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'livemd2tex-sync-test-'));
    try {
      const repo = path.join(tmp, 'repo');
      mkdirSync(repo);
      assert.match(h.loadPrivateTexts(repo).problems.join(), /no \.private-fixtures\.json/);
      writeFileSync(path.join(repo, '.private-fixtures.json'), JSON.stringify({ root: '../fixtures', fixtures: {} }));
      const missing = h.loadPrivateTexts(repo).problems.join('; ');
      assert.match(missing, /fixtures folder .* is absent/);
      assert.match(missing, /names no private test folder/);
      mkdirSync(path.join(tmp, 'fixtures'));
      mkdirSync(path.join(tmp, 'overlay'));
      writeFileSync(path.join(tmp, 'fixtures', 'paper.md'), PARAGRAPH);
      writeFileSync(path.join(repo, '.private-fixtures.json'), JSON.stringify({ root: '../fixtures', privateTests: '../overlay', fixtures: {} }));
      const ok = h.loadPrivateTexts(repo);
      assert.deepEqual(ok.problems, []);
      assert.deepEqual(ok.texts, [PARAGRAPH]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('knows the private files by name (G0S-03)', () => {
    for (const p of ['.private-fixtures.json', '.private-markers.json', 'docs/.private-notes.md']) {
      assert.equal(h.isPrivatePath(p), true, p);
    }
    assert.equal(h.isPrivatePath('.private-fixtures.example.json'), false, 'the published template');
    assert.equal(h.isPrivatePath('scripts/private-tests.mjs'), false);
  });

  it('treats another drive as outside, and a device spelling never as outside (G0S-04)', () => {
    assert.equal(paths.isOutside(root, path.join(root, 'test')), false);
    assert.equal(paths.isOutside(root, path.join(root, '..', 'elsewhere')), true);
    assert.equal(paths.isOutside(root, path.join(root, '..x')), false);
    assert.equal(paths.isOutside(root, `\\\\?\\${path.join(root, 'sub')}`), false);
    assert.equal(paths.isOutside(root, `\\\\.\\${path.join(root, 'sub')}`), false);
    if (process.platform === 'win32') {
      const other = root.toUpperCase().startsWith('C:') ? 'D:\\temp\\x' : 'C:\\temp\\x';
      assert.equal(paths.isOutside(root, other), true);
    }
  });
});
