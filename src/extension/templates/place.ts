// Where a new document goes (docs/DESIGN.md#help-for-new-users): a new folder with a free name under the parent
// folder, and every file created new, never over an existing one. The promise "the new folder never replaces one
// that exists" holds by construction, not only while a folder listing works:
//   - only a parent that does not exist counts as empty; any other failure to list it refuses, with nothing
//     written;
//   - the chosen folder must not exist, even when the listing did not show it;
//   - each file is created only if it does not exist (FolderOps.createNew refuses an existing file).
// The file operations are passed in (newDocument.ts gives VS Code's), so the rules are tested without VS Code.

import { freeName } from './catalog';

/** The file operations, with paths relative to the parent folder ("/" separators). */
export interface FolderOps {
  /** The names in the parent folder; 'missing' when the parent does not exist. Throws on any other failure. */
  listParent(): Promise<string[] | 'missing'>;
  /** True when the path exists. Throws when that cannot be told. */
  exists(rel: string): Promise<boolean>;
  /** Makes a folder and the folders above it. */
  makeFolder(rel: string): Promise<void>;
  /** Creates a file that does not exist yet; fails, writing nothing, when it exists. */
  createNew(rel: string, data: Uint8Array): Promise<void>;
}

/** The new document was not made; the message says why, in plain words. */
export class NewDocumentRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NewDocumentRefused';
  }
}

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Makes the folder `base` (or a free variant of it) under the parent and creates `files` in it. Returns the
 * folder's name. `parentLabel` names the parent in messages.
 */
export async function placeNewFolder(ops: FolderOps, base: string, files: { to: string; data: Uint8Array }[], parentLabel: string): Promise<string> {
  let listed: string[] | 'missing';
  try {
    listed = await ops.listParent();
  } catch (err) {
    throw new NewDocumentRefused(`The folder ${parentLabel} could not be read (${reason(err)}), so no new document was made there.`);
  }
  const folder = freeName(base, listed === 'missing' ? [] : listed);
  let there: boolean;
  try {
    there = await ops.exists(folder);
  } catch (err) {
    throw new NewDocumentRefused(`It could not be checked whether ${parentLabel} already has a folder "${folder}" (${reason(err)}), so nothing was written.`);
  }
  if (there) {
    throw new NewDocumentRefused(`${parentLabel} already has a folder "${folder}", so nothing was written. Choose another folder, or try again.`);
  }
  await ops.makeFolder(folder);
  const made = new Set([folder]);
  for (const file of files) {
    const rel = `${folder}/${file.to}`;
    const dir = rel.slice(0, rel.lastIndexOf('/'));
    if (!made.has(dir)) {
      await ops.makeFolder(dir);
      made.add(dir);
    }
    try {
      await ops.createNew(rel, file.data);
    } catch (err) {
      throw new NewDocumentRefused(`${rel} could not be created (${reason(err)}); a file that was there is left as it was.`);
    }
  }
  return folder;
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Runs `place` after every earlier run has finished, so two runs at once (two API calls, a test, another
 * extension) never share a folder: the second one lists the parent after the first has made its folder, and
 * takes the next free name.
 */
export function oneAtATime<T>(place: () => Promise<T>): Promise<T> {
  const run = queue.then(place, place);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
