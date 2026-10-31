/**
 * kpathsea's file name database (ls-R) for a tree, from its tree-relative file paths: the header line, then each
 * folder (in ls -R order) as "./path:" and its entries, folders and files, sorted. The same text as
 * scripts/lib/texmf-config.mjs's lsR, which writes the images' own ls-R files (test/unit/addOnSearch.test.ts
 * checks that the two agree).
 *
 * The engine host writes one for the data extensions' tree (/texmf-extra) from the files it has mounted there, so
 * kpathsea finds an add-on's files from its database and never searches that tree on disk: our texmf.cnf lists
 * /texmf-extra in TEXMFDBS, and the worker marks its path element "!!" (docs/DESIGN.md, "Mounting").
 */
export function lsR(paths: Iterable<string>): string {
  const dirs = new Map<string, Set<string>>([['', new Set()]]);
  for (const p of paths) {
    const parts = p.split('/');
    let dir = '';
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      let entries = dirs.get(dir);
      if (entries === undefined) {
        entries = new Set();
        dirs.set(dir, entries);
      }
      entries.add(name);
      dir = dir ? `${dir}/${name}` : name;
      if (i < parts.length - 1 && !dirs.has(dir)) {
        dirs.set(dir, new Set());
      }
    }
  }
  const out = ['% ls-R -- filename database for kpathsea; do not change this line.'];
  const visit = (dir: string): void => {
    out.push(dir ? `./${dir}:` : './:');
    const names = [...(dirs.get(dir) ?? [])].sort();
    out.push(...names, '');
    for (const name of names) {
      const sub = dir ? `${dir}/${name}` : name;
      if (dirs.has(sub)) {
        visit(sub);
      }
    }
  };
  visit('');
  return `${out.join('\n')}\n`;
}
