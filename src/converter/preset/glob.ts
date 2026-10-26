// A preset's entry globs ("paper*.md", "si?.md") come from a repository and are untrusted
// (docs/DESIGN.md#presets): a glob of a dozen stars given to RegExp held the thread for minutes. This matcher is a plain loop with
// one way back (to the last star), so it takes at most (glob length) x (name length) steps, and both are capped.

/** A glob longer than this never matches (the preset loads with a problem). */
export const MAX_GLOB_LENGTH = 200;
/** A file name longer than this matches no glob. */
export const MAX_NAME_LENGTH = 255;

/**
 * True when the file name matches the glob: "*" is any run of characters, "?" is one character, the rest is
 * literal; case is ignored. A file name has no "/"; a name with one matches only a glob equal to it.
 */
export function globMatches(glob: string, name: string): boolean {
  if (glob.length > MAX_GLOB_LENGTH || name.length > MAX_NAME_LENGTH) {
    return false;
  }
  const g = [...glob.toLowerCase()];
  const s = [...name.toLowerCase()];
  if (s.includes('/')) {
    return g.join('') === s.join('');
  }
  let gi = 0;
  let si = 0;
  let star = -1;
  let resume = 0;
  while (si < s.length) {
    if (gi < g.length && g[gi] === '*') {
      // Remember the star; it first matches nothing.
      star = gi++;
      resume = si;
    } else if (gi < g.length && (g[gi] === '?' || g[gi] === s[si])) {
      gi++;
      si++;
    } else if (star >= 0) {
      // Let the last star take one more character and try again from there.
      gi = star + 1;
      si = ++resume;
    } else {
      return false;
    }
  }
  while (gi < g.length && g[gi] === '*') {
    gi++;
  }
  return gi === g.length;
}
