// Path checks for the development scripts.

import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

/** The real path of `p` (links and drive mappings resolved), through its nearest existing folder. */
function real(p) {
  let cur = path.resolve(p);
  const rest = [];
  while (!existsSync(cur)) {
    const up = path.dirname(cur);
    if (up === cur) {
      return path.resolve(p);
    }
    rest.unshift(path.basename(cur));
    cur = up;
  }
  try {
    return path.join(realpathSync.native(cur), ...rest);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Whether `p` lies outside the folder `root`, compared by real paths, so a link, a subst drive or a mapped drive
 * into the repository counts as inside. On Windows a path on another drive is outside: path.relative then gives an
 * absolute path, not one that starts with "..". A device or long-path spelling (\\?\, \\.\) is never taken as
 * outside: every caller asks this to make sure something stays out of the repository, so it fails closed.
 */
export function isOutside(root, p) {
  if (/^[\\/]{2}[?.][\\/]/.test(p)) {
    return false;
  }
  const rel = path.relative(real(root), real(p));
  return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
}
