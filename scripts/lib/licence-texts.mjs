// The licence texts each data package ships (B1; docs/DESIGN.md#engine-and-data): its LICENSES/ folder holds the
// texts its packages' licences require, and LICENSES/INDEX lists each package with its licence files. The rules are
// in engine/bundle-licences.json:
//   texts     the licence texts by id: a file in this repository with its pinned SHA-256 (the LaTeX Project's own
//             LPPL texts, SPDX's licence list, the GUST Font License from the snapshot's lm package, MakeIndex's
//             notice from TeX Live's sources), or a file of a package's archive in the pinned snapshot (TeX Live's
//             own LICENSE.TL), which the archive's SHA-512 vouches for.
//   keys      each Catalogue licence: the texts it needs (the GPL's, the LPPL's), whether the package's own licence
//             files go with it ("own": an OFL font's copyright notice and Reserved Font Names, an MIT or BSD
//             notice), and whether its terms must be found in the package itself ("terms": "other-free" and an
//             unnamed BSD licence have no common text). "(none)" is a package with no Catalogue licence: TeX
//             Live's own files.
//   packages  a package whose files carry a licence the Catalogue does not name ("own": its licence files must be
//             found; DejaVu's fonts and the Bitstream Vera and Arev terms), or whose notice is in TeX Live's
//             sources ("texts").
//   readings  a package whose terms a person read: the shipped files that state them, the files of its doc or source
//             archives that state them (shipped in its LICENSES folder), and the texts they name.
//   fontTerms each Type 1 font's own terms, from its header (classifyFonts): they decide which core fonts are packed
//             with t1c, and add their texts to the package's (a GPL font in an LPPL package; IBM's Courier).
//   engineFiles the texts of the files the core takes from the engine build's image (ICU's data).
// A package's own licence files come from its run archive (also those the image leaves out, under doc/ or at the
// archive's root) and, when a key or the package asks for them, from its doc and source archives, checked against
// the tlpdb's SHA-512 like every archive. For a licence with no common text, a file that states the terms (a README,
// the .ins file) is taken when no licence file is there, and a shipped TeX file whose own text states them counts
// too. A licence with no rule, a text that is missing or not the pinned one, and a package whose own text or terms
// are not found stop the build. A package that ships no file needs no text.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { readTar } from './tar.mjs';
import { unxz } from './xz.mjs';

/** File names that hold a licence: LICENSE, COPYING, COPYRIGHT (copyrite.txt), OFL.txt, lppl.txt, GUST-FONT-LICENSE.txt and the MANIFEST-*.txt files the GUST Font License asks for, gpl-3.0.txt, NOTICE, bsdlic.txt. */
const LICENCE_NAME = /licen[cs]e|copying|^copyri(?:ght|te)|^ofl\b|^ofl[-_.]|^lppl|^gpl|^lgpl|^agpl|^fdl[-_.]|^notice|^manifest|bsdlic/i;
/** Names that look like a licence's but are TeX, fonts, pictures, programs or documents: copyrightbox.sty, license.pdf. */
const NOT_TEXT = /\.(sty|cls|clo|fd|def|cfg|ldf|lua|bst|bbx|cbx|dbx|bib|ist|tfm|vf|pfb|pfm|afm|otf|ttf|ttc|map|enc|pdf|ps|eps|png|jpe?g|gif|svg|dvi|html?|zip|gz|xz|tgz|py|pl|pm|rb|js|mjs|ts|c|h|cc|cpp|java|go|rs|awk|sed|tcl|sh|bat|cmd|ps1|vbs|exe|dll|so|jar|whl|xpm|makefile)$|^makefile$/i;
/** A README by its name: README, README.md, 00readme.txt, readme.charter, LISEZMOI. */
const README = /^(?:00)?read[._-]?me|^lisezmoi/i;
const base = (rel) => rel.slice(rel.lastIndexOf('/') + 1);

/** Whether a file (texmf-relative, or at the archive's root) is a licence file by its name. */
export function isLicenceFile(rel) {
  const b = base(rel);
  return LICENCE_NAME.test(b) && !NOT_TEXT.test(b);
}

/**
 * Whether a file of a doc or source archive may state a package's terms: a README, a .ins or .dtx file, a manual
 * page or another text file (not TeX's own files, a font, a picture, a PDF or a program).
 */
export function mayStateTerms(rel) {
  return !NOT_TEXT.test(base(rel));
}

/**
 * Statements of terms, for a licence with no common text ("terms"): a BSD licence must be named or given in full;
 * any other ("other-free") must say how the file may be used or passed on.
 */
export const TERMS = {
  bsd: /Redistribution and use in source and binary forms|\bBSD\b/,
  any: /\b(?:distributed|released|available|licen[cs]ed|provided) under\b|\bunder the (?:terms|conditions)\b|\bPublic Licen[cs]e\b|\bpermission (?:is|to)\b|\bredistribut|\bmay (?:not )?be (?:freely )?(?:copied|distributed|used|modified|changed|transmitted|reproduced)|\bfree to (?:copy|use|modify|distribute)|\bfreely (?:use|distribut|redistribut|cop|modif|transmit|available)|\bpublic domain\b|\bunlimited copying\b|\bwithout restriction\b|\bmust not be (?:modified|changed)|\bdon't modify\b|\bunless the file ?name is (?:also )?changed|\b(?:MIT|BSD|Apache|Creative Commons)\b.{0,20}\blicen[cs]e/i,
};
const TEX_TEXT = /\.(sty|cls|tex|ltx|def|cfg|clo|fd|ldf|lua|bst|bbx|cbx|dbx|mf|mp|ist|txt)$/i;

/** The first of `files` whose text states terms for `key` ("bsd" or another), or null. `order` ranks the files. */
function stating(files, key, order) {
  const re = key.startsWith('bsd') ? TERMS.bsd : TERMS.any;
  const names = [...files.keys()].sort((a, b) => order(a) - order(b) || files.get(a).length - files.get(b).length || (a < b ? -1 : 1));
  return names.find((f) => re.test(files.get(f).subarray(0, 65536).toString('latin1'))) ?? null;
}

/** The first shipped TeX file of a package whose head states its terms (`key`: "bsd" or another), or null. */
export function termsIn(shipped, key) {
  const heads = new Map([...shipped].filter(([f]) => TEX_TEXT.test(f)).map(([f, b]) => [f, b.subarray(0, 8192)]));
  return stating(heads, key, (f) => (/\.(sty|cls)$/i.test(f) ? 0 : /\.tex$/i.test(f) ? 1 : 2));
}

/** The README of a package's doc or source archive that states its terms, or null. */
export function termsInReadme(docs, key) {
  return stating(new Map([...docs].filter(([f]) => README.test(base(f)))), key, () => 0);
}

/** Another file of a package's doc or source archive that states its terms: a .ins file first, then the smallest; or null. */
export function termsInDocs(docs, key) {
  return stating(docs, key, (f) => (/\.ins$/i.test(f) ? 0 : 1));
}

/**
 * A doc or source archive's files for the licence texts (xz-compressed tar, as TeX Live ships them): its licence
 * files by name, and the other text files of at most 256 kB that may state the terms, by texmf-relative path.
 */
export function archiveTexts(xzBytes) {
  const own = new Map();
  const docs = new Map();
  for (const entry of readTar(unxz(xzBytes))) {
    if (entry.type !== 'file' || entry.path.startsWith('tlpkg/')) {
      continue;
    }
    const rel = entry.path.replace(/^texmf-dist\//, '');
    if (isLicenceFile(rel)) {
      own.set(rel, Buffer.from(entry.data));
    } else if (mayStateTerms(rel) && entry.data.length <= 262144) {
      docs.set(rel, Buffer.from(entry.data));
    }
  }
  return { own, docs };
}

/** The keys of a package's licences, "(none)" for no Catalogue licence. */
const keysOf = (licences) => (licences.length ? licences : ['(none)']);

/**
 * The archives besides the run archive a package's licence texts need: "doc" when a key or the package asks for its
 * own licence files and the tlpdb lists some in its doc files, or a key needs its terms found; "source" when a key
 * needs its terms found (a .ins or .dtx often states them). Only archives the tlpdb lists.
 */
export function licenceArchives(name, pkg, licences, rules) {
  const keys = keysOf(licences).map((k) => rules.keys[k] ?? {});
  const reading = rules.readings?.[name];
  const terms = keys.some((r) => r.terms) && !rules.packages?.[name]?.texts && !reading;
  const own = rules.packages?.[name]?.own === true || keys.some((r) => r.own);
  const read = (prefix) => (reading?.archiveFiles ?? []).some((f) => f.startsWith(prefix));
  const out = [];
  if (pkg.docContainerChecksum && (terms || read('doc/') || (own && (pkg.docfiles ?? []).some((f) => isLicenceFile(f))))) {
    out.push('doc');
  }
  if (pkg.srcContainerChecksum && (terms || read('source/'))) {
    out.push('source');
  }
  return out;
}

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

/**
 * The texts engine/bundle-licences.json names that live in this repository, each checked against its pinned
 * SHA-256; a text from a package's archive comes in through `fromArchives` (id -> bytes).
 */
export function loadTexts(root, rules, fromArchives = new Map()) {
  const texts = new Map();
  const problems = [];
  for (const [id, t] of Object.entries(rules.texts)) {
    if (t.package) {
      const bytes = fromArchives.get(id);
      if (bytes) {
        texts.set(id, bytes);
      }
      continue; // missing only matters when a package needs it
    }
    const file = path.join(root, t.file);
    if (!existsSync(file)) {
      problems.push(`licence text ${id}: ${t.file} is not in the repository`);
      continue;
    }
    const bytes = readFileSync(file);
    if (sha256(bytes) !== t.sha256) {
      problems.push(`licence text ${id}: ${t.file} is not the pinned text (SHA-256 ${sha256(bytes)}, pinned ${t.sha256})`);
      continue;
    }
    texts.set(id, bytes);
  }
  return { texts, problems };
}

/** A Type 1 font's clear-text header (its first PFB segment, or the start of a PFA): its comments, /Notice and /Copyright. */
export function fontHeader(bytes) {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  const length = b.length >= 6 && b[0] === 0x80 && b[1] === 1 ? Math.min(b.readUInt32LE(2), b.length - 6) : -1;
  return (length >= 0 ? b.subarray(6, 6 + length) : b.subarray(0, 8192)).toString('latin1');
}

/**
 * The terms a font's own header states, by engine/bundle-licences.json's "fontTerms" (the first class that matches,
 * unless its "unless" matches too): { class, line } with the line that matched; { class: "reference" } when the
 * header points to its package's licence ("See the file COPYING"); { class: "silent" } when it states none.
 */
export function fontTerms(bytes, rules) {
  const header = fontHeader(bytes);
  for (const c of rules.fontTerms.classes) {
    const re = new RegExp(c.match, 'i');
    if (re.test(header) && !(c.unless && new RegExp(c.unless, 'i').test(header))) {
      return { class: c.class, line: header.split(/\r\n|\r|\n/).find((l) => re.test(l))?.trim() ?? '' };
    }
  }
  return { class: new RegExp(rules.fontTerms.reference, 'i').test(header) ? 'reference' : 'silent', line: '' };
}

/**
 * Each Type 1 font's terms, decided per font (the t1c gate, T1S-01): the class its own header states, else its
 * package's class (lppl or gpl, from the Catalogue: packedFontLicences) when the header points to the package's
 * licence or states nothing. In a package whose fonts state different terms ("mixed"), a font that states nothing is
 * "unclear". A font is packed only when its class is lppl, gpl or vera (rules: "pack"); any other is stored as it is,
 * with the reason. Also each package's licence texts that its fonts' own terms add, and the notices to extract.
 * @param {{ path: string, package: string, group: string, bytes: Uint8Array }[]} fonts
 * @returns {{ fonts: Map<string, { package: string, class: string, pack: boolean, reason: string, line: string }>, texts: Map<string, Set<string>>, notices: Map<string, { class: string, files: string[], lines: string[] }[]> }}
 */
export function classifyFonts(fonts, rules) {
  const classes = new Map(rules.fontTerms.classes.map((c) => [c.class, c]));
  const terms = new Map(fonts.map((f) => [f.path, fontTerms(f.bytes, rules)]));
  const mixed = new Set(fonts.filter((f) => classes.has(terms.get(f.path).class) && terms.get(f.path).class !== f.group).map((f) => f.package));
  const out = new Map();
  const texts = new Map();
  const notices = new Map();
  for (const f of fonts) {
    const t = terms.get(f.path);
    const rule = classes.get(t.class);
    let result;
    if (rule) {
      result = { class: t.class, pack: rule.pack === true, reason: rule.pack ? '' : rule.reason, line: t.line };
      (rule.texts ?? []).forEach((id) => texts.set(f.package, new Set([...(texts.get(f.package) ?? []), id])));
      if (rule.extract) {
        const list = notices.get(f.package) ?? [];
        let entry = list.find((n) => n.class === t.class);
        if (!entry) {
          entry = { class: t.class, files: [], lines: [] };
          list.push(entry);
          notices.set(f.package, list);
        }
        entry.files.push(f.path);
        const re = new RegExp(rule.match, 'i');
        fontHeader(f.bytes)
          .split(/\r\n|\r|\n/)
          .filter((l) => re.test(l) || /copyright|trademark|notice/i.test(l))
          .map((l) => l.trim())
          .forEach((l) => entry.lines.includes(l) || entry.lines.push(l));
      }
    } else if (t.class === 'silent' && mixed.has(f.package)) {
      result = { class: 'unclear', pack: false, reason: rules.fontTerms.unclear, line: '' };
    } else {
      const ok = rules.fontTerms.packable.includes(f.group);
      result = { class: f.group, pack: ok, reason: ok ? '' : rules.fontTerms.unread, line: '' };
    }
    out.set(f.path, { package: f.package, ...result });
  }
  return { fonts: out, texts, notices };
}

/** The text of a package's font notices file: the notices its fonts' own headers state, by class, with the files. */
export function fontNoticesText(name, entries) {
  const parts = [`The notices that ${name}'s fonts state in their own headers, as they state them, by kind of terms.`, ''];
  for (const e of entries) {
    parts.push(`Fonts (${e.class}): ${e.files.join(', ')}`, '', ...e.lines, '');
  }
  return `${parts.join('\n')}`;
}

/**
 * The LICENSES/ folder of one data package: the files (path under LICENSES/ -> bytes), the INDEX text, and the
 * problems that stop the build.
 * @param {string} set  core-data or extra-data
 * @param {{ name: string, licences: string[], own: Map<string, Buffer>, docs?: Map<string, Buffer>, shipped: Map<string, Buffer>, fontTexts?: Set<string>, fontNotices?: { class: string, files: string[], lines: string[] }[] }[]} packages
 *   each package with its Catalogue licences (licenceOf); its licence files by name, from its run, doc and source
 *   archives (texmf-relative paths, or root names); the other files of its doc and source archives that may state
 *   its terms (mayStateTerms); its shipped files (texmf-relative); and the texts and notices its fonts' own headers
 *   add (classifyFonts)
 */
export function licenceFolder(set, packages, rules, texts, engineFiles = []) {
  const files = new Map();
  const problems = [];
  const rows = [];
  /** The terms the builder found by reading text, not by a licence file's name: for a person to check. */
  const found = [];
  const addText = (p, id, entries) => {
    const bytes = texts.get(id);
    if (!bytes) {
      problems.push(`${set}: ${p.name} needs the licence text ${id}, which the build does not have`);
      return;
    }
    files.set(`texts/${id}.txt`, bytes);
    entries.push(`texts/${id}.txt`);
  };
  const addOwn = (p, rel, bytes, entries) => {
    files.set(`packages/${p.name}/${rel}`, bytes);
    entries.push(`packages/${p.name}/${rel}`);
  };
  for (const p of [...packages].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const keys = keysOf(p.licences);
    if (p.shipped.size === 0) {
      rows.push(`${p.name}\t${keys.join(' ')}\tships no files`);
      continue;
    }
    const override = rules.packages?.[p.name];
    const reading = rules.readings?.[p.name];
    const entries = [];
    let wantOwn = override?.own === true;
    const termKeys = [];
    for (const key of keys) {
      const rule = rules.keys[key];
      if (!rule) {
        problems.push(`${set}: ${p.name} is under the licence "${key}", which engine/bundle-licences.json has no rule for`);
        continue;
      }
      (rule.texts ?? []).forEach((id) => addText(p, id, entries));
      wantOwn ||= rule.own === true || rule.terms === true;
      if (rule.terms) {
        termKeys.push(key);
      }
    }
    (override?.texts ?? []).forEach((id) => addText(p, id, entries));
    // The texts its fonts' own headers name (classifyFonts), and the notices they state, where a rule extracts them.
    [...(p.fontTexts ?? [])].sort().forEach((id) => addText(p, id, entries));
    if (p.fontNotices?.length) {
      files.set(`packages/${p.name}/font-notices.txt`, Buffer.from(fontNoticesText(p.name, p.fontNotices), 'utf8'));
      entries.push(`packages/${p.name}/font-notices.txt`);
    }
    const own = [...p.own.keys()].filter(isLicenceFile).sort();
    if (wantOwn) {
      own.forEach((rel) => addOwn(p, rel, p.own.get(rel), entries));
    }
    if (override?.own && own.length === 0) {
      problems.push(`${set}: ${p.name}'s licence files are not in its archives (${override.reason})`);
    }
    if (termKeys.length > 0 && own.length === 0 && !override?.texts) {
      if (reading) {
        const absent = (reading.files ?? []).filter((f) => !p.shipped.has(f));
        if (absent.length > 0) {
          problems.push(`${set}: ${p.name}'s terms were read in ${absent.join(', ')}, which the set does not ship`);
        }
        entries.push(...(reading.files ?? []).map((f) => `terms in data:${f}`));
        // Files of its doc or source archives that state the terms (a .dtx whose generated files say "see the
        // source file"; a README that names the licence): they ship in its LICENSES folder.
        for (const rel of reading.archiveFiles ?? []) {
          const bytes = p.docs?.get(rel) ?? p.own.get(rel);
          if (bytes) {
            addOwn(p, rel, bytes, entries);
          } else {
            problems.push(`${set}: ${p.name}'s terms were read in ${rel}, which its archives do not hold`);
          }
        }
        (reading.texts ?? []).forEach((id) => addText(p, id, entries));
      } else {
        // A README that states the terms, then a shipped file whose own text states them, then another doc or
        // source file (a .ins file first).
        for (const key of termKeys) {
          const docs = p.docs ?? new Map();
          const readme = termsInReadme(docs, key);
          const shipped = readme ? null : termsIn(p.shipped, key);
          const doc = readme ?? (shipped ? null : termsInDocs(docs, key));
          if (doc) {
            addOwn(p, doc, docs.get(doc), entries);
            found.push({ set, package: p.name, file: `LICENSES/packages/${p.name}/${doc}` });
          } else if (shipped) {
            entries.push(`terms in data:${shipped}`);
            found.push({ set, package: p.name, file: `data:${shipped}` });
          } else {
            problems.push(`${set}: ${p.name} is under "${key}", and no licence file, no README or source file stating its terms, and no statement in its own files was found; read its files and record them in engine/bundle-licences.json ("readings"), or leave it out`);
          }
        }
      }
    }
    rows.push(`${p.name}\t${keys.join(' ')}\t${[...new Set(entries)].join(' ') || '-'}`);
  }
  // The files the core takes from the engine build's image (ICU's data among them), by the rules' path patterns.
  const engineRows = [];
  const patterns = Object.entries(rules.engineFiles ?? {}).filter(([k]) => k !== 'about');
  for (const file of [...engineFiles].map((f) => f.replace(/^\//, '')).sort()) {
    const rule = patterns.find(([re]) => new RegExp(re).test(file))?.[1];
    if (!rule) {
      problems.push(`${set}: ${file}, from the engine build's image, matches no rule in engine/bundle-licences.json ("engineFiles")`);
      continue;
    }
    const entries = [];
    (rule.texts ?? []).forEach((id) => addText({ name: file }, id, entries));
    engineRows.push(`${file}\t(engine build)\t${entries.join(' ') || '-'}`);
  }
  const head = [
    `# The licence texts of the TeX Live packages in data/ (${set}), written by liveMd2Tex's bundle builder.`,
    '# One line per package, tab-separated: its name, its licences as the TeX Catalogue names them ("(none)": TeX',
    "# Live's own files), and its licence files in this folder. texts/ holds each licence text once; packages/<name>/",
    "# holds a package's own licence files and the README or source file that states its terms, as its archives hold",
    '# them. "terms in data:<file>" names a file in the data image whose own text states the terms. "-": the licence',
    '# needs no text (public domain; Knuth\'s terms, which the files state). "ships no files": nothing of it is here.',
    '',
  ];
  const engineHead = engineRows.length > 0 ? ['', "# The files from the engine build's image, by path: their licence texts. ICU's data is ICU 78.2 (Unicode License V3),", "# from libs/icu in TeX Live's source tree at tag texlive-2026.0: https://github.com/TeX-Live/texlive-source.", ''] : [];
  return { files, index: `${[...head, ...rows, ...engineHead, ...engineRows].join('\n')}\n`, problems, found };
}

/** What t1c did to each packed font, for the GPL's change notices (LICENSES/CHANGES-GPL). */
export const T1C_CHANGE = 'stored with its eexec and charstring encryption removed for compression; restored byte for byte before use';

/**
 * LICENSES/CHANGES-GPL: the GPL's notice of changes (GPL-2 section 2(a), GPL-3 section 5(a)) for every packed file
 * under the GPL, one line each: its path in the image, its package, the SHA-256 of the original, what was done, and
 * the date of the build.
 * @param {{ path: string, package: string, sha256: string }[]} files
 */
export function gplChanges(set, files, date) {
  const head = [
    `# Changes to files under the GNU General Public License in this data package (${set}), written by liveMd2Tex's`,
    '# bundle builder. The GPL asks that a changed file carry a notice of the change and its date (version 2,',
    '# section 2(a); version 3, section 5(a)). These are the Type 1 fonts that are stored packed; liveMd2Tex restores',
    "# each to its original bytes, checked against the original's SHA-256, before TeX reads it.",
    "# One line per file, tab-separated: its path in the data image, its package, the original's SHA-256, what was done,",
    '# and the date of the build.',
    '',
  ];
  const rows = [...files].sort((a, b) => (a.path < b.path ? -1 : 1)).map((f) => `${f.path}\t${f.package}\t${f.sha256}\t${T1C_CHANGE}\t${date}`);
  return `${[...head, ...rows].join('\n')}\n`;
}

/** The paths that a CHANGES-GPL text lists. */
export const gplChangesPaths = (text) => new Set(text.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split('\t')[0]));
