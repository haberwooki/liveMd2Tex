// Packages a data set built by B1 (scripts/build-bundle.mjs) as a data-only VS Code extension (docs/DESIGN.md#store-and-packaging):
// package.json with no code, README.md, LICENSE.txt, LICENSES/ (the licence texts its packages require, with
// LICENSES/INDEX; scripts/lib/licence-texts.mjs writes them), and data/ (manifest.json, the image and its index, and
// licences.json, each package's Catalogue licence and CTAN path, and for a package under the GPL, LGPL or AGPL its
// archives in the pinned snapshot). The TeX files come from TeX Live, each under its own licence (LPPL 1.3c clause 3:
// a Compiled Work from complete, unmodified packages, with a pointer to the sources: the pinned snapshot, which keeps
// the version shipped, and CTAN; the licence gate, M6). Every file TeX reads is the unmodified file. In a set whose image packs its Type 1 fonts (core-data:
// t1c, docs/DESIGN.md#engine-and-data), those fonts are stored decrypted and restored to the original bytes, checked
// against each original's SHA-256, before TeX reads them; README.md and LICENSE.txt say so, and LICENSE.txt quotes
// the LPPL 1.3c's clause 9 on alternative formats and names the packages whose fonts are stored as they are.

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DESCRIPTIONS = {
  'core-data': {
    displayName: 'liveMd2Tex Core Packages',
    description: "The TeX packages and fonts liveMd2Tex compiles with: TeX Live's basic and LaTeX collections and the common packages of papers, slides and theses.",
  },
  'extra-data': {
    displayName: 'liveMd2Tex Extra Packages',
    description: 'More TeX packages and fonts for liveMd2Tex: the rest of the recommended and extra LaTeX collections, publisher classes, biblatex styles and more.',
  },
};

/** The LPPL 1.3c's clause 9, word for word (LICENSES/LPPL-1.3c.txt). */
const LPPL_CLAUSE_9 =
  'Distribution of the Work or any Derived Work in an alternative format, where the Work or that Derived Work (in whole or in part) is then produced by applying some process to that format, does not relax or nullify any sections of this license as they pertain to the results of applying that process.';

/** Wraps text at 115 columns, for the plain-text files. */
function wrap(text, indent = '') {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && indent.length + line.length + 1 + word.length > 115) {
      lines.push(indent + line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) {
    lines.push(indent + line);
  }
  return lines.join('\n');
}

/** How a packed image stores its Type 1 fonts, for README.md and LICENSE.txt. */
const PACKED_FONTS =
  'The Type 1 font files (.pfb) whose terms allow it are stored with their encryption removed (the eexec section and each charstring), so that they compress; this is lossless. Before TeX reads such a file, liveMd2Tex encrypts it again with the Type 1 format\'s fixed keys, which gives back the original file byte for byte, and checks the result against the SHA-256 of the original, which data/manifest.json lists for each such file. A file that fails the check is not given to TeX. So every file TeX reads is the unmodified file from TeX Live.';

/** The README's sentence on the TeX files. */
export function readmeFiles(year, packed, gplChanges = false) {
  return packed
    ? `The TeX files are TeX Live ${year}'s packages. ${PACKED_FONTS} data/licences.json lists each package with its licence and its CTAN page; LICENSES/ holds the licence texts, and LICENSES/INDEX names each package's;${gplChanges ? " LICENSES/CHANGES-GPL lists each font under the GNU GPL that is stored this way, with its original's SHA-256, what was done and the date;" : ''} LICENSE.txt gives the terms.`
    : `The TeX files are TeX Live ${year}'s packages, unchanged; data/licences.json lists each package with its licence and its CTAN page; LICENSES/ holds the licence texts, and LICENSES/INDEX names each package's.`;
}

/** A list item: "- " and the text, its later lines indented under the text. */
const item = (text) => wrap(`- ${text}`, '  ').replace(/^ {2}/, '');

/**
 * LICENSE.txt. `fonts` is undefined for an image that stores its files as they are; for one that packs its Type 1
 * fonts, it gives the packages whose packed fonts are under each kind of terms, by each font's own header or, where
 * the font states none, its package's licence (classifyFonts in scripts/lib/licence-texts.mjs: lppl for the LPPL and
 * the GUST Font License, vera for DejaVu's Bitstream Vera and Arev terms, gpl); `kept`, the packages whose fonts are
 * all stored as they are, with the reason (engine/bundle-sets.json, core-data's "t1cSkip"); `unpacked`, by package,
 * the fonts stored as they are because of their own terms, with the reason; `gplChanges`: whether
 * LICENSES/CHANGES-GPL lists packed GPL fonts. `snapshot`: the pinned TeX Live snapshot the files come from, its date and
 * its tlnet URL, and where the releases are (the data package's GitHub releases, which attach the archives).
 * @param {{ lppl: string[], vera?: string[], gpl: string[], kept: Record<string, string>, unpacked?: Record<string, { reason: string, files: string[] }[]>, gplChanges?: boolean } | undefined} fonts
 * @param {{ date: string, url: string, releases: string }} snapshot
 */
export function licenceFile(fonts, snapshot) {
  if (!snapshot?.date || !snapshot.url || !snapshot.releases) {
    throw new Error('licenceFile: the snapshot (date, url, releases) is needed, so LICENSE.txt can say where the sources are');
  }
  const parts = [
    wrap(
      `The TeX packages and fonts in data/ ${fonts ? 'come' : 'are distributed unchanged'} from TeX Live, each under its own licence, which data/licences.json names (from the TeX Catalogue). Most are under the LaTeX Project Public License 1.3c (https://www.latex-project.org/lppl/), distributed under its clause 3 as a Compiled Work generated from complete, unmodified copies of each package.`,
    ),
    wrap(
      `Where the sources are. The files are taken from TeX Live's snapshot of ${snapshot.date}, ${snapshot.url}, which keeps each package as this data package has it: its files in archive/<package>.tar.xz and, where it has them, its sources in archive/<package>.source.tar.xz and its documentation in archive/<package>.doc.tar.xz. For each package under the GNU GPL, LGPL or AGPL, and each package with a packed font under the GPL, data/licences.json lists these archives ("archives"), each with its URL and the SHA-512 that TeX Live's package database gives for it, and the GitHub release that publishes this data package (${snapshot.releases}) carries a copy of each. Each package's page on CTAN (https://ctan.org/, at the path data/licences.json gives) has its newest version.`,
    ),
    wrap(
      `LICENSES/ holds the licence texts these packages' licences require, and LICENSES/INDEX lists each package with its licence files: the texts of its licences, its own licence files (an OFL font's copyright notice and Reserved Font Names, an MIT or BSD notice), or the file that states its terms.`,
    ),
  ];
  if (fonts) {
    parts.push(wrap(`How the Type 1 fonts are stored. ${PACKED_FONTS}`));
    parts.push(
      wrap(
        "Which fonts are stored this way is decided font by font, by the terms the font's own header states. Where a font states none, or points to its package's licence, its package's licence applies; a font that states none in a package whose fonts state different terms is stored as it is.",
      ),
    );
    if (fonts.lppl.length > 0) {
      parts.push(
        wrap(
          `The packed fonts of these packages are under the GUST Font License, which is the LPPL 1.3c or later with one request that is not legally required, or under the LPPL 1.3 to 1.3c: ${fonts.lppl.join(', ')}. Clause 9 of the LPPL, the same in versions 1.3 and 1.3c, speaks to this form:`,
        ),
      );
      parts.push(wrap(`"${LPPL_CLAUSE_9}"`, '    '));
      parts.push(wrap('Here the process gives back each font unmodified, and the licence applies to it in full.'));
    }
    if ((fonts.vera ?? []).length > 0) {
      parts.push(
        wrap(
          `The packed fonts of these packages carry the Bitstream Vera and Arev terms: ${fonts.vera.join(', ')}. They allow a modified font only under a name without the words "Bitstream" or "Vera" (and, in the Arev terms, "Tavmjong Bah" or "Arev"). These fonts' names contain none of these words, and TeX reads the original files.`,
        ),
      );
    }
    if (fonts.gpl.length > 0) {
      parts.push(
        wrap(
          `The packed fonts of these packages are under the GNU General Public License: ${fonts.gpl.join(', ')}. For them, too, the stored form is a lossless encoding, as the image's own compression is, and TeX reads each file verbatim.`,
        ),
      );
    }
    if (fonts.gplChanges) {
      parts.push(
        wrap(
          "The GPL asks that a changed file carry a notice of the change and its date (version 2, section 2(a); version 3, section 5(a)). LICENSES/CHANGES-GPL lists every packed font under the GPL: its path, its package, its original's SHA-256, what was done to it, and the date of the build.",
        ),
      );
    }
    const kept = Object.keys(fonts.kept).sort();
    if (kept.length > 0) {
      parts.push([wrap('The fonts of these packages are stored as they are, not decrypted:'), ...kept.map((n) => item(`${n}: ${fonts.kept[n]}.`))].join('\n'));
    }
    const unpacked = Object.entries(fonts.unpacked ?? {}).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    if (unpacked.length > 0) {
      parts.push(
        [
          wrap('These fonts are stored as they are, by the terms their own headers state:'),
          ...unpacked.flatMap(([name, list]) => list.map((e) => item(`${name}, ${e.files.length === 1 ? 'one font' : `${e.files.length} fonts`} (${e.files.map((f) => f.slice(f.lastIndexOf('/') + 1)).join(', ')}): ${e.reason}.`))),
        ].join('\n'),
      );
    }
  }
  parts.push(wrap('The rest of this package (package.json, README.md, this file, data/manifest.json) is GPL-3.0-or-later, as liveMd2Tex.'));
  return `${parts.join('\n\n')}\n`;
}

/**
 * Writes the package's files into `dir` (which already holds data/) and makes the VSIX; returns its size.
 * `fonts`: for a set whose image packs its Type 1 fonts, which packages' fonts are packed and which are not (licenceFile).
 * `snapshot`: the pinned snapshot's date and tlnet URL, for LICENSE.txt's pointer to the sources.
 */
export async function packageDataSet(root, dir, set, version, vsixPath, fonts = undefined, snapshot = undefined) {
  const manifest = JSON.parse(readFileSync(path.join(dir, 'data', 'manifest.json'), 'utf8'));
  const packed = manifest.image?.packed !== undefined;
  if (!existsSync(path.join(dir, 'LICENSES', 'INDEX'))) {
    throw new Error(`${set}: LICENSES/INDEX is missing; the build writes the licence texts before it packages a set`);
  }
  if (fonts?.gplChanges && !existsSync(path.join(dir, 'LICENSES', 'CHANGES-GPL'))) {
    throw new Error(`${set}: LICENSES/CHANGES-GPL is missing; the build writes it after it packs the fonts`);
  }
  if (packed !== (fonts !== undefined)) {
    throw new Error(`${set}: data/manifest.json says the Type 1 fonts are ${packed ? '' : 'not '}packed, and the builder says the opposite`);
  }
  const identity = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const semver = version.replace(/^(\d{4})\.0?(\d+)\.0?(\d+)$/, '$1.$2.$3');
  const pkg = {
    name: `livemd2tex-${set}`,
    ...DESCRIPTIONS[set],
    version: semver,
    publisher: identity.publisher,
    license: 'SEE LICENSE IN LICENSE.txt',
    engines: { vscode: identity.engines?.vscode ?? '^1.105.0' },
    categories: ['Other'],
    extensionKind: ['ui', 'workspace'],
    repository: identity.repository,
  };
  writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync(
    path.join(dir, 'README.md'),
    `# ${pkg.displayName}\n\n${pkg.description}\n\nA data-only extension: it holds no code. liveMd2Tex reads its data/manifest.json and mounts its one data image. ${readmeFiles(version.slice(0, 4), packed, fonts?.gplChanges === true)}\n`,
  );
  const releases = `${String(identity.repository?.url ?? identity.repository).replace(/\.git$/, '')}/releases`;
  writeFileSync(path.join(dir, 'LICENSE.txt'), licenceFile(fonts, { ...snapshot, releases }));
  const vsce = await import('@vscode/vsce');
  await vsce.createVSIX({ cwd: dir, packagePath: vsixPath, dependencies: false, allowMissingRepository: true });
  return { file: vsixPath, bytes: statSync(vsixPath).size };
}
