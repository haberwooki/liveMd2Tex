// The Git reader (docs/DESIGN.md#architecture): isomorphic-git on a read-only file system, the linked-worktree commondir
// wrapper, and the rule that CRLF-only differences count as unchanged. Repositories are built in a temporary
// folder with isomorphic-git itself (no git.exe; the process stub would block it anyway). The linked worktree is
// laid out file by file the way git worktree add lays it out; and when this checkout is itself a linked
// worktree made by git (a worktree on the development machine), the reader is checked on it too.

import * as assert from 'node:assert/strict';
import { existsSync, promises as fsp, readFileSync, statSync } from 'node:fs';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as git from 'isomorphic-git';
import { isomorphicGitFs, normalizePath } from '../../src/git/fs';
import { commondirFs, findRepository, GitReader, GitReaderError, isCommonPath, sameContent } from '../../src/git/repository';
import { stubState } from '../support/helpers';
import { nodeFs, root } from './support';

const author = { name: 'Test Author', email: 'test@example.org', timestamp: 1760000000, timezoneOffset: 0 };
const slash = (p: string) => p.replace(/\\/g, '/');

async function commitFiles(dir: string, files: Record<string, string>, message: string): Promise<string> {
  for (const [name, text] of Object.entries(files)) {
    await fsp.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fsp.writeFile(path.join(dir, name), text);
    await git.add({ fs, dir, filepath: name });
  }
  return git.commit({ fs, dir, author, committer: author, message });
}

describe('Git reader (isomorphic-git, read-only)', () => {
  let tmp: string;

  before(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'livemd2tex-c0a-git-'));
  });
  after(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it('decides which gitdir paths a linked worktree shares (git path.c common_list)', () => {
    for (const p of ['objects/ab/cdef', 'refs/heads/main', 'refs/tags/v1', 'packed-refs', 'config', 'shallow', 'logs/refs/heads/main', 'info/exclude', 'hooks/pre-commit']) {
      assert.equal(isCommonPath(p), true, p);
    }
    for (const p of ['HEAD', 'index', 'ORIG_HEAD', 'MERGE_HEAD', 'logs/HEAD', 'refs/bisect/bad', 'refs/worktree/x', 'refs/rewritten/y', 'info/sparse-checkout', 'commondir', 'gitdir']) {
      assert.equal(isCommonPath(p), false, p);
    }
  });

  it('treats CRLF-only differences as the same content, and nothing else', () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    assert.equal(sameContent(enc('a\nb\n'), enc('a\r\nb\r\n')), true);
    assert.equal(sameContent(enc('a\r\nb'), enc('a\nb')), true);
    assert.equal(sameContent(enc('a\nb\n'), enc('a\nB\n')), false);
    assert.equal(sameContent(enc('a\rb'), enc('a\nb')), false);
  });

  describe('in an ordinary repository', () => {
    let dir: string;
    let reader: GitReader;
    const tex = '\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n';

    before(async () => {
      dir = path.join(tmp, 'plain');
      await fsp.mkdir(dir);
      await git.init({ fs, dir, defaultBranch: 'main' });
      await commitFiles(dir, { 'docs/paper.tex': tex, 'notes.md': '# Notes\n', 'gone.txt': 'x\n' }, 'first');
      const opened = await GitReader.open(nodeFs(), slash(path.join(dir, 'docs', 'paper.tex')));
      assert.ok(opened);
      reader = opened;
    });

    it('finds the repository from a file deep inside it', () => {
      assert.equal(reader.location.worktree, normalizePath(dir));
      assert.equal(reader.location.linked, false);
      assert.equal(reader.relative(slash(path.join(dir, 'docs', 'paper.tex'))), 'docs/paper.tex');
    });

    it('reads a file at HEAD, and the commit it came from', async () => {
      const bytes = await reader.readCommitted(slash(path.join(dir, 'docs', 'paper.tex')));
      assert.equal(new TextDecoder().decode(bytes), tex);
      const head = await reader.head();
      assert.equal(head?.branch, 'main');
      assert.equal(head?.summary, 'first');
      assert.equal(await reader.readCommitted(slash(path.join(dir, 'nothere.tex'))), undefined);
    });

    it('reports unmodified, CRLF-only (unmodified), modified, new, deleted and absent', async () => {
      const file = path.join(dir, 'docs', 'paper.tex');
      assert.equal(await reader.status(slash(file)), 'unmodified');
      await fsp.writeFile(file, tex.replace(/\n/g, '\r\n'));
      assert.equal(await reader.status(slash(file)), 'unmodified');
      await fsp.writeFile(file, tex.replace('Hello', 'Changed'));
      assert.equal(await reader.status(slash(file)), 'modified');
      await fsp.writeFile(path.join(dir, 'new.tex'), 'new\n');
      assert.equal(await reader.status(slash(path.join(dir, 'new.tex'))), 'new');
      await fsp.rm(path.join(dir, 'gone.txt'));
      assert.equal(await reader.status(slash(path.join(dir, 'gone.txt'))), 'deleted');
      assert.equal(await reader.status(slash(path.join(dir, 'never.tex'))), 'absent');
    });

    it('never writes: every write through its file system fails', async () => {
      const client = isomorphicGitFs(nodeFs());
      await assert.rejects(client.promises.writeFile(), /read-only/);
      await assert.rejects(client.promises.unlink(), /read-only/);
      await assert.rejects(client.promises.mkdir(), /read-only/);
    });

    it('returns undefined outside any repository', async () => {
      const outside = path.join(tmp, 'outside');
      await fsp.mkdir(outside);
      // The temporary folder is not in a repository on any normal machine; skip if it is.
      const above = await findRepository(nodeFs(), slash(outside));
      if (above === undefined) {
        assert.equal(await GitReader.open(nodeFs(), slash(path.join(outside, 'a.tex'))), undefined);
      }
    });
  });

  describe('with packfiles and packed refs', () => {
    it('reads through a pack and a packed-refs file after the loose objects are gone', async () => {
      const dir = path.join(tmp, 'packed');
      await fsp.mkdir(dir);
      await git.init({ fs, dir, defaultBranch: 'main' });
      const first = await commitFiles(dir, { 'a.tex': 'one\n' }, 'one');
      const head = await commitFiles(dir, { 'a.tex': 'two\n', 'b/c.tex': 'c\n' }, 'two');
      const objects = path.join(dir, '.git', 'objects');
      const oids: string[] = [];
      for (const d of await fsp.readdir(objects)) {
        if (/^[0-9a-f]{2}$/.test(d)) {
          for (const f of await fsp.readdir(path.join(objects, d))) {
            oids.push(d + f);
          }
        }
      }
      const { filename } = await git.packObjects({ fs, dir, oids, write: true });
      await git.indexPack({ fs, dir, filepath: `.git/objects/pack/${filename}` });
      for (const d of await fsp.readdir(objects)) {
        if (/^[0-9a-f]{2}$/.test(d)) {
          await fsp.rm(path.join(objects, d), { recursive: true });
        }
      }
      await fsp.writeFile(path.join(dir, '.git', 'packed-refs'), `# pack-refs with: peeled fully-peeled sorted \n${head} refs/heads/main\n`);
      await fsp.rm(path.join(dir, '.git', 'refs', 'heads', 'main'));

      const reader = await GitReader.open(nodeFs(), slash(path.join(dir, 'a.tex')));
      assert.ok(reader);
      assert.equal(new TextDecoder().decode(await reader.readCommitted(slash(path.join(dir, 'b', 'c.tex')))), 'c\n');
      assert.equal(await reader.status(slash(path.join(dir, 'a.tex'))), 'unmodified');
      assert.equal(new TextDecoder().decode(await reader.readCommitted(slash(path.join(dir, 'a.tex')), first)), 'one\n');
    });
  });

  describe('in a linked worktree', () => {
    let main: string;
    let worktree: string;

    before(async () => {
      main = path.join(tmp, 'main');
      worktree = path.join(tmp, 'wt');
      await fsp.mkdir(main);
      await git.init({ fs, dir: main, defaultBranch: 'main' });
      await commitFiles(main, { 'paper.tex': 'main version\n' }, 'on main');
      await git.branch({ fs, dir: main, ref: 'feature', checkout: true });
      await commitFiles(main, { 'paper.tex': 'feature version\n' }, 'on feature');
      await git.checkout({ fs, dir: main, ref: 'main' });
      // What "git worktree add ../wt feature" leaves behind.
      const admin = path.join(main, '.git', 'worktrees', 'wt');
      await fsp.mkdir(admin, { recursive: true });
      await fsp.writeFile(path.join(admin, 'HEAD'), 'ref: refs/heads/feature\n');
      await fsp.writeFile(path.join(admin, 'commondir'), '../..\n');
      await fsp.writeFile(path.join(admin, 'gitdir'), `${slash(path.join(worktree, '.git'))}\n`);
      await fsp.mkdir(worktree);
      await fsp.writeFile(path.join(worktree, '.git'), `gitdir: ${slash(admin)}\n`);
      await fsp.writeFile(path.join(worktree, 'paper.tex'), 'feature version\r\n');
    });

    it('fails without the wrapper (isomorphic-git ignores commondir) ...', async () => {
      const admin = slash(path.join(main, '.git', 'worktrees', 'wt'));
      await assert.rejects(git.resolveRef({ fs: isomorphicGitFs(nodeFs()), dir: slash(worktree), gitdir: admin, ref: 'HEAD' }));
    });

    it('... and reads the worktree branch through the commondir wrapper', async () => {
      const reader = await GitReader.open(nodeFs(), slash(path.join(worktree, 'paper.tex')));
      assert.ok(reader);
      assert.equal(reader.location.linked, true);
      assert.equal(reader.location.commondir, normalizePath(path.join(main, '.git')));
      assert.equal(new TextDecoder().decode(await reader.readCommitted(slash(path.join(worktree, 'paper.tex')))), 'feature version\n');
      assert.equal((await reader.head())?.branch, 'feature');
      assert.equal(await reader.status(slash(path.join(worktree, 'paper.tex'))), 'unmodified', 'CRLF-only difference');
      const mainReader = await GitReader.open(nodeFs(), slash(path.join(main, 'paper.tex')));
      assert.equal(new TextDecoder().decode(await mainReader?.readCommitted(slash(path.join(main, 'paper.tex')))), 'main version\n');
    });

    it('wraps only the shared paths', async () => {
      const admin = normalizePath(path.join(main, '.git', 'worktrees', 'wt'));
      const wrapped = commondirFs(nodeFs(), admin, normalizePath(path.join(main, '.git')));
      assert.equal(new TextDecoder().decode(await wrapped.readFile(`${admin}/HEAD`)), 'ref: refs/heads/feature\n');
      assert.ok((await wrapped.readdir(`${admin}/refs/heads`)).includes('feature'));
    });

    it('gives a plain message when the common folder is missing', async () => {
      const broken = path.join(tmp, 'broken');
      const admin = path.join(tmp, 'broken-admin');
      await fsp.mkdir(broken);
      await fsp.mkdir(admin);
      await fsp.writeFile(path.join(admin, 'commondir'), '../no-such-folder\n');
      await fsp.writeFile(path.join(broken, '.git'), `gitdir: ${slash(admin)}\n`);
      await assert.rejects(GitReader.open(nodeFs(), slash(path.join(broken, 'a.tex'))), (err: unknown) => err instanceof GitReaderError && /common git folder/.test((err as Error).message));
    });
  });

  it('refuses a SHA-256 repository with a plain message', async () => {
    const dir = path.join(tmp, 'sha256');
    await fsp.mkdir(path.join(dir, '.git'), { recursive: true });
    await fsp.writeFile(path.join(dir, '.git', 'config'), '[core]\n\trepositoryformatversion = 1\n[extensions]\n\tobjectformat = sha256\n');
    await assert.rejects(GitReader.open(nodeFs(), slash(path.join(dir, 'a.tex'))), /SHA-256/);
  });

  it("reads this checkout when it is a linked worktree made by git (a worktree on the development machine)", async function () {
    const dotgit = path.join(root, '.git');
    if (!existsSync(dotgit) || !statSync(dotgit).isFile()) {
      this.skip();
    }
    const reader = await GitReader.open(nodeFs(), slash(path.join(root, 'LICENSE')));
    assert.ok(reader);
    assert.equal(reader.location.linked, true);
    const committed = await reader.readCommitted(slash(path.join(root, 'LICENSE')));
    assert.ok(committed && committed.length > 30000);
    assert.equal(await reader.status(slash(path.join(root, 'LICENSE'))), 'unmodified');
    const pkg = JSON.parse(new TextDecoder().decode(await reader.readCommitted(slash(path.join(root, 'package.json'))))) as { name: string };
    assert.equal(pkg.name, JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).name);
    assert.ok((await reader.head())?.oid.match(/^[0-9a-f]{40}$/));
  });

  it('starts no process and opens no connection', async () => {
    const state = stubState();
    state.clearBlocked();
    const reader = await GitReader.open(nodeFs(), slash(path.join(tmp, 'plain', 'notes.md')));
    await reader?.status(slash(path.join(tmp, 'plain', 'notes.md')));
    assert.deepEqual(state.blocked, []);
  });
});
