// The engine's components and their notices (engine/engine-notices.json; THIRD_PARTY_NOTICES.md, "Inside the engine";
// the licence gates, L-01, M2 to M4, L2-01). The table in THIRD_PARTY_NOTICES.md is written from the manifest.
// test/unit/engineNotices.test.ts checks that it is, that every archive on the manifest's copy of TeXlyre's link
// lines is a component's, and that the manifest names the TeXlyre commit and release engine/pins.json pins.
// scripts/release-sources.mjs checks the copy against the Makefile in TeXlyre's archive at that commit.
//
//   node scripts/lib/engine-notices.mjs     prints the table
//   node scripts/lib/engine-notices.mjs --release-notice [MANIFEST]
//                                           prints the NOTICE of an engine release (default manifest:
//                                           engine/engine-notices.next.json; scripts/engine-release.mjs writes it)

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

/**
 * A notice file's name among an engine release's assets, which GitHub keeps flat: LICENSES/engine/X and LICENSES/X
 * keep their file name, LICENSE (ours, GPL-3.0) becomes GPL-3.0.txt.
 */
export const releaseAssetName = (p) => (p === 'LICENSE' ? 'GPL-3.0.txt' : path.posix.basename(p));

/**
 * The NOTICE of an engine release (scripts/engine-release.mjs): the licence statement, then every component of the
 * manifest (engine/engine-notices.next.json until it replaces engine-notices.json) with its version, licence,
 * copyright, the notice files that ship beside it (by their asset names) and its note.
 */
export function releaseNotice(manifest) {
  const wrap = (text, indent = '') => {
    const words = String(text).split(/\s+/).filter(Boolean);
    const lines = [];
    let line = '';
    for (const w of words) {
      if (line && line.length + 1 + w.length > 100 - indent.length) {
        lines.push(indent + line);
        line = w;
      } else line = line ? `${line} ${w}` : w;
    }
    if (line) lines.push(indent + line);
    return lines.join('\n');
  };
  const out = [
    "NOTICE: liveMd2Tex's TeX engine (engine.wasm and engine.js)",
    '',
    wrap(
      "The engine holds pdfTeX, XeTeX, xdvipdfmx and bibtex8 with kpathsea and the libraries they need, built into one WebAssembly file by liveMd2Tex's engine/build/. Our own code is GPL-3.0-or-later. The engine as a whole can be passed on under GPL-3.0 (xpdf allows GPL-2.0 or GPL-3.0 and no later version), and each part keeps its own terms.",
    ),
    '',
    wrap(
      `Built from TeX Live's source at commit ${manifest.build.texLive.commit} and Emscripten ${manifest.build.emscripten.release} (commit ${manifest.build.emscripten.commit}). The source archives, their addresses and SHA-256, and the commit of the build scripts are in the release notes; the exact flags, the lists of renamed and shared names, the toolchain and the output hashes are in engine-build.json.`,
    ),
    '',
    'The parts, each with its licence and the files of this release that hold its notices:',
  ];
  for (const c of manifest.components) {
    out.push('', `- ${c.name}`);
    out.push(wrap(`Version: ${c.version}`, '  '));
    out.push(wrap(`Licence: ${c.licence}`, '  '));
    if (c.copyright) out.push(wrap(`Copyright: ${c.copyright}`, '  '));
    out.push(wrap(`Notices: ${c.notices.length ? c.notices.map(releaseAssetName).join(', ') : 'none needed'}`, '  '));
    if (c.note) out.push(wrap(`Note: ${c.note}`, '  '));
  }
  out.push('');
  return out.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--release-notice');
  if (i >= 0) process.stdout.write(releaseNotice(loadEngineNotices(process.argv[i + 1] ?? path.join(root, 'engine', 'engine-notices.next.json'))));
  else console.log(noticesTable(loadEngineNotices()));
}
