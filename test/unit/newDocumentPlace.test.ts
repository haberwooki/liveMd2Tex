// "New document from template" never replaces anything (src/extension/templates/place.ts;
// docs/DESIGN.md#help-for-new-users): on an in-memory folder, a parent that cannot be listed is refused with
// nothing written; a folder the listing did not show but that is there is refused; a file that appears before
// it is created is left as it was; a missing parent is made; two runs at once take two folders.

import * as assert from 'node:assert/strict';
import { NewDocumentRefused, oneAtATime, placeNewFolder, type FolderOps } from '../../src/extension/templates/place';

const enc = new TextEncoder();
const FILES = [
  { to: 'main.tex', data: enc.encode('new main') },
  { to: 'references.bib', data: enc.encode('new bib') },
  { to: 'presets/two-column-paper/preset.json', data: enc.encode('{}') },
];

/** A folder held in memory: file and folder paths relative to the parent. */
class MemoryFolder implements FolderOps {
  readonly files = new Map<string, string>();
  readonly folders = new Set<string>();
  parentExists = true;
  listFails: Error | null = null;
  /** Names the listing leaves out (a listing that is incomplete, as on some remote file systems). */
  hidden = new Set<string>();
  /** Files that appear just before they would be created (another program writing at the same time). */
  appearing = new Map<string, string>();
  writes = 0;

  async listParent(): Promise<string[] | 'missing'> {
    if (this.listFails) {
      throw this.listFails;
    }
    if (!this.parentExists) {
      return 'missing';
    }
    const top = new Set([...this.folders, ...this.files.keys()].map((p) => p.split('/')[0]));
    return [...top].filter((n) => !this.hidden.has(n));
  }
  async exists(rel: string): Promise<boolean> {
    return this.folders.has(rel) || this.files.has(rel);
  }
  async makeFolder(rel: string): Promise<void> {
    this.parentExists = true;
    const parts = rel.split('/');
    for (let i = 1; i <= parts.length; i++) {
      this.folders.add(parts.slice(0, i).join('/'));
    }
  }
  async createNew(rel: string, data: Uint8Array): Promise<void> {
    const early = this.appearing.get(rel);
    if (early !== undefined) {
      this.files.set(rel, early);
    }
    if (this.files.has(rel)) {
      throw new Error('it already exists');
    }
    this.files.set(rel, new TextDecoder().decode(data));
    this.writes++;
  }
}

describe('New document from template: nothing is replaced', () => {
  it('makes the folder with a free name and creates every file', async () => {
    const fs = new MemoryFolder();
    fs.makeFolder('article');
    fs.files.set('article/main.tex', 'mine');
    const folder = await placeNewFolder(fs, 'article', FILES, 'Documents');
    assert.equal(folder, 'article-2');
    assert.equal(fs.files.get('article/main.tex'), 'mine');
    assert.equal(fs.files.get('article-2/main.tex'), 'new main');
    assert.equal(fs.files.get('article-2/presets/two-column-paper/preset.json'), '{}');
  });

  it('makes a parent that does not exist', async () => {
    const fs = new MemoryFolder();
    fs.parentExists = false;
    assert.equal(await placeNewFolder(fs, 'article', FILES, 'Documents'), 'article');
    assert.equal(fs.writes, FILES.length);
  });

  it('refuses, writing nothing, when the parent cannot be listed (a permission error, a remote failure)', async () => {
    const fs = new MemoryFolder();
    fs.makeFolder('article');
    fs.files.set('article/main.tex', 'mine');
    fs.listFails = Object.assign(new Error('permission denied'), { code: 'NoPermissions' });
    await assert.rejects(placeNewFolder(fs, 'article', FILES, 'Documents'), (err: unknown) => {
      assert.ok(err instanceof NewDocumentRefused);
      assert.match(err.message, /could not be read \(permission denied\), so no new document was made/);
      return true;
    });
    assert.equal(fs.writes, 0);
    assert.equal(fs.files.get('article/main.tex'), 'mine');
  });

  it('refuses when the chosen folder is there although the listing did not show it', async () => {
    const fs = new MemoryFolder();
    fs.makeFolder('article');
    fs.files.set('article/main.tex', 'mine');
    fs.hidden.add('article');
    await assert.rejects(placeNewFolder(fs, 'article', FILES, 'Documents'), /already has a folder "article", so nothing was written/);
    assert.equal(fs.writes, 0);
    assert.equal(fs.files.get('article/main.tex'), 'mine');
  });

  it('leaves a file that appears before it is created as it was, and says so', async () => {
    const fs = new MemoryFolder();
    fs.appearing.set('article/references.bib', 'theirs');
    await assert.rejects(placeNewFolder(fs, 'article', FILES, 'Documents'), /article\/references\.bib could not be created \(it already exists\); a file that was there is left as it was/);
    assert.equal(fs.files.get('article/references.bib'), 'theirs');
  });
  it('two runs at once never share a folder: one runs after the other', async () => {
    // Without the queue, both runs list the parent before either has made its folder.
    const racing = new MemoryFolder();
    const raced = await Promise.all([placeNewFolder(racing, 'article', FILES, 'Documents'), placeNewFolder(racing, 'article', FILES, 'Documents')].map((p) => p.catch((err: Error) => err.message)));
    assert.notDeepEqual(raced.sort(), ['article', 'article-2'], 'the fake folder no longer shows the race; the test proves nothing');
    // With it, the second run sees the first one's folder and takes the next name.
    const fs = new MemoryFolder();
    const placed = await Promise.all([
      oneAtATime(() => placeNewFolder(fs, 'article', FILES, 'Documents')),
      oneAtATime(() => placeNewFolder(fs, 'article', FILES, 'Documents')),
    ]);
    assert.deepEqual(placed, ['article', 'article-2']);
    assert.equal(fs.writes, 2 * FILES.length);
    // A run that fails does not stop the next one.
    const broken = new MemoryFolder();
    broken.listFails = new Error('permission denied');
    const after = new MemoryFolder();
    const [failed, next] = await Promise.all([
      oneAtATime(() => placeNewFolder(broken, 'article', FILES, 'Documents')).catch((err: Error) => err.message),
      oneAtATime(() => placeNewFolder(after, 'article', FILES, 'Documents')),
    ]);
    assert.match(failed, /could not be read/);
    assert.equal(next, 'article');
  });
});
