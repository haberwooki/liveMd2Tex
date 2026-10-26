// The generated files of a TeX tree (B1; docs/DESIGN.md#engine-and-data), made the way TeX Live's tlmgr and updmap
// make them, but in JavaScript, since the builder may start no Perl:
//   - language.dat, language.def and language.dat.lua from the packages' AddHyphen actions (TLUtils
//     create_language_*: the template language.us*, then "from <package>:" blocks in package-name order);
//   - fmtutil.cnf from AddFormat actions, and updmap.cfg from the font map actions;
//   - pdftex.map (pdftex_dl14.map, the default "download base 14" variant), pdftex_ndl14.map and kanjix.map, as
//     updmap builds them: the base-35 block (ps2pk35.map or pdftex35.map), then the MixedMap fonts, then the Map
//     fonts, each font from the map that wins it, with whitespace collapsed and repeated lines dropped;
//   - ls-R, kpathsea's file name database.
// Where updmap's own order is not defined (two maps of one updmap.cfg that define the same font), the first map in
// name order wins here, and the conflict is reported.

/** The lines of a template file, without a trailing empty line. */
const lines = (text) => text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');

function blocks(hyphens, db, comment, make) {
  const out = [];
  let lastPackage;
  for (const h of hyphens) {
    if (!h.databases.includes(db)) {
      continue;
    }
    if (h.package !== lastPackage) {
      out.push(`${comment} from ${h.package}:`);
      lastPackage = h.package;
    }
    if (h.comment) {
      out.push(`${comment} ${h.comment}`);
    }
    out.push(...make(h));
  }
  return out;
}

/** language.dat: the template, then "name file" and "=synonym" lines. */
export function languageDat(template, hyphens) {
  return [...lines(template), ...blocks(hyphens, 'dat', '%', (h) => [`${h.name} ${h.file}`, ...h.synonyms.map((s) => `=${s}`)])].join('\n') + '\n';
}

/** language.def: the template, \addlanguage lines for each name and synonym, and the closing \uselanguage. */
export function languageDef(template, hyphens) {
  const add = (name, h) => `\\addlanguage{${name}}{${h.file}}{}{${h.lefthyphenmin}}{${h.righthyphenmin}}`;
  return (
    [
      ...lines(template),
      ...blocks(hyphens, 'def', '%', (h) => [add(h.name, h), ...h.synonyms.map((s) => add(s, h))]),
      '%%% No changes may be made beyond this point.',
      '',
      '\\uselanguage {USenglish}             %%% This MUST be the last line of the file.',
    ].join('\n') + '\n'
  );
}

/** language.dat.lua: the template (which opens the table), one entry per language, and the closing brace. */
export function languageLua(template, hyphens) {
  const q = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  const entry = (h) => [
    `\t['${h.name}'] = {`,
    `\t\tloader = ${q(h.file)},`,
    `\t\tlefthyphenmin = ${h.lefthyphenmin},`,
    `\t\trighthyphenmin = ${h.righthyphenmin},`,
    `\t\tsynonyms = { ${h.synonyms.map(q).join(', ')} },`,
    ...(h.filePatterns ? [`\t\tpatterns = ${q(h.filePatterns)},`] : []),
    ...(h.fileExceptions ? [`\t\thyphenation = ${q(h.fileExceptions)},`] : []),
    ...(h.luaspecial ? [`\t\tspecial = ${q(h.luaspecial)},`] : []),
    '\t},',
  ];
  return [...lines(template), ...blocks(hyphens, 'lua', '--', entry), '}'].join('\n') + '\n';
}

/** fmtutil.cnf: the header, then "# from <package>:" blocks of "name engine patterns options" lines. */
export function fmtutilCnf(header, formats) {
  const out = [...lines(header)];
  let lastPackage;
  for (const f of formats) {
    if (f.package !== lastPackage) {
      out.push('#', `# from ${f.package}:`);
      lastPackage = f.package;
    }
    out.push(`${f.mode ? '' : '#! '}${f.name} ${f.engine} ${f.patterns} ${f.options}`.trimEnd());
  }
  return out.join('\n') + '\n';
}

/** updmap.cfg: the header, then "Map file" lines sorted by file name. */
export function updmapCfg(header, maps) {
  const body = [...maps].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([file, m]) => `${m.kind} ${file}`);
  return [...lines(header), ...body].join('\n') + '\n';
}

/** A map file's fonts: { tex font name -> the rest of its line }; comments and blank lines skipped, last line wins. */
export function readMapFile(text) {
  const fonts = new Map();
  for (const raw of lines(text)) {
    if (/^\s*[#%]/.test(raw) || /^\s*$/.test(raw)) {
      continue;
    }
    const line = raw.trim();
    const space = line.search(/\s/);
    if (space < 0) {
      fonts.set(line, '');
    } else {
      fonts.set(line.slice(0, space), line.slice(space).trim());
    }
  }
  return fonts;
}

/** Collapses whitespace, drops blank lines, and keeps only the first of repeated lines (updmap's normalizeLines). */
function normalize(list) {
  const seen = new Set();
  const out = [];
  for (const l of list) {
    const line = l.replace(/\s+/g, ' ').trim();
    if (line !== '' && !seen.has(line)) {
      seen.add(line);
      out.push(line);
    }
  }
  return out;
}

/**
 * The font maps updmap makes: pdftex_dl14.map (also as pdftex.map), pdftex_ndl14.map and kanjix.map.
 * @param {Map<string, { kind: string }>} maps the updmap.cfg entries, file name -> kind
 * @param {(file: string) => string | undefined} read the text of a map file found in the tree
 */
export function buildFontMaps(maps, read) {
  const missing = [];
  const conflicts = [];
  const origin = new Map();
  const loaded = new Map();
  const load = (file) => {
    if (!loaded.has(file)) {
      const text = read(file);
      if (text === undefined) {
        missing.push(file);
        loaded.set(file, null);
      } else {
        loaded.set(file, readMapFile(text));
      }
    }
    return loaded.get(file);
  };
  for (const builtin of ['dvips35.map', 'pdftex35.map', 'ps2pk35.map']) {
    for (const font of load(builtin)?.keys() ?? []) {
      origin.set(font, builtin);
    }
  }
  const names = [...maps.keys()].sort();
  for (const file of names) {
    for (const font of load(file)?.keys() ?? []) {
      const was = origin.get(font);
      if (was === undefined || was.endsWith('35.map')) {
        origin.set(font, file);
      } else if (was !== file) {
        conflicts.push(`${font}: ${was} and ${file} (${was} kept)`);
      }
    }
  }
  const fontsOf = (file, all) => {
    const fonts = loaded.get(file);
    if (!fonts) {
      return [];
    }
    const keep = [...fonts.keys()].filter((f) => all || origin.get(f) === file).sort();
    return [`% ${file}`, ...keep.map((f) => `${f} ${fonts.get(f)}`)];
  };
  const of = (kind) => names.filter((n) => maps.get(n).kind === kind).flatMap((n) => fontsOf(n, false));
  const mixed = of('MixedMap');
  const plain = of('Map');
  const dl14 = normalize([...fontsOf('ps2pk35.map', true), ...mixed, ...plain]);
  const ndl14 = normalize([...fontsOf('pdftex35.map', true), ...mixed, ...plain]);
  const kanjix = normalize(of('KanjiMap'));
  const text = (l) => l.join('\n') + '\n';
  return { pdftexDl14: text(dl14), pdftexNdl14: text(ndl14), kanjix: text(kanjix), missing, conflicts };
}

/**
 * kpathsea's ls-R for a tree, from its texmf-relative file paths: the header line, then each folder (in ls -R
 * order) as "./path:" and its entries, folders and files, sorted.
 */
export function lsR(paths) {
  const dirs = new Map([['', new Set()]]);
  for (const p of paths) {
    const parts = p.split('/');
    let dir = '';
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      if (!dirs.has(dir)) {
        dirs.set(dir, new Set());
      }
      dirs.get(dir).add(name);
      dir = dir ? `${dir}/${name}` : name;
      if (i < parts.length - 1 && !dirs.has(dir)) {
        dirs.set(dir, new Set());
      }
    }
  }
  const out = ['% ls-R -- filename database for kpathsea; do not change this line.'];
  const visit = (dir) => {
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
  return out.join('\n') + '\n';
}
