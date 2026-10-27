// The engine's components and their notices (engine/engine-notices.json; THIRD_PARTY_NOTICES.md, "Inside the engine";
// the licence gates, L-01, M2 to M4, L2-01). The table in THIRD_PARTY_NOTICES.md is written from the manifest.
// test/unit/engineNotices.test.ts checks that it is, that every archive on the manifest's copy of TeXlyre's link
// lines is a component's, and that the manifest names the TeXlyre commit and release engine/pins.json pins.
// scripts/release-sources.mjs checks the copy against the Makefile in TeXlyre's archive at that commit.
//
//   node scripts/lib/engine-notices.mjs     prints the table

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function loadEngineNotices(file = path.join(root, 'engine', 'engine-notices.json')) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/**
 * The objects and archives the engine's link line (Makefile line 376) links: its own objects, and those of the
 * OBJ_ variables it names, each as its file name.
 */
export function linkedFiles(manifest) {
  const lines = manifest.makefile.lines;
  const link = lines['376'];
  const variables = new Map(
    Object.values(lines)
      .map((l) => /^(OBJ_[A-Z_]+)\s*=\s*(.*)$/.exec(l))
      .filter(Boolean)
      .map((m) => [m[1], m[2]]),
  );
  const names = (text) => [...text.matchAll(/[\w.+-]+\.(?:a|o)\b/g)].map((m) => m[0].slice(m[0].lastIndexOf('/') + 1));
  const own = [...link.matchAll(/(?:\$\(basename \$@\)\.o|[\w$*/.-]+\/([\w.-]+\.o))/g)].map((m) => (m[1] ? m[1] : 'busytex.o'));
  const used = [...link.matchAll(/\$\((OBJ_[A-Z_]+)\)/g)].map((m) => m[1]);
  const fromVariables = used.flatMap((v) => {
    if (!variables.has(v)) {
      throw new Error(`the link line names ${v}, which engine-notices.json's makefile lines lack`);
    }
    return names(variables.get(v).replace(/\$\(addprefix [^,]+,/g, ''));
  });
  return [...new Set([...own, ...fromVariables])].sort();
}

/** Where a notice file is in the package: dist/licenses/... (LICENSE ships as GPL-3.0.txt). */
export const inPackage = (p) => (p === 'LICENSE' ? 'dist/licenses/GPL-3.0.txt' : `dist/licenses/${p.replace(/^LICENSES\//, '')}`);

/** THIRD_PARTY_NOTICES.md's "Inside the engine" table. */
export function noticesTable(manifest) {
  const cell = (s) => String(s).replace(/\|/g, '\\|');
  const rows = manifest.components.map((c) => {
    const files = c.notices.length ? c.notices.map((n) => `\`${inPackage(n)}\``).join(', ') : c.absent ? `none: ${c.absent}` : (c.note ?? 'none needed');
    return `| ${cell(c.name)}${c.copyright ? `; ${cell(c.copyright)}` : ''} | ${cell(c.version)} | ${cell(c.licence)} | ${files} |`;
  });
  return ['| Part | Version | Licence | Notices in the package |', '|---|---|---|---|', ...rows].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(noticesTable(loadEngineNotices()));
}
