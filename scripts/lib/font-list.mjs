// scripts/lib/font-list.mjs: the font list XeTeX's fontconfig stand-in reads (engine/build/fontlist). For each face of each font file it writes what fontconfig 2.13.96 puts in the pattern
// XeTeX asks for: the file, the face index, the family, style and full names, the PostScript name, and weight,
// width and slant. XeTeX does the matching itself; these names decide which faces it reads (XeTeXFontMgr_FC.cpp:
// 207-300 at TeX Live 6a300188).
//
// Ours (the liveMd2Tex authors), GPL-3.0-or-later. Written from fontconfig 2.13.96's src/fcfreetype.c
// (FcFreeTypeQueryAll, FcFreeTypeQueryFaceInternal, FcSfntNameTranscode) and src/fcweight.c, which were read and
// written anew in JavaScript, and from the OpenType specification (the name, OS/2, head, fvar tables) and the WOFF 1.0
// specification. The weight, width and slant tables below (WEIGHT_MAP, WEIGHT_WORDS, WIDTH_WORDS, SLANT_WORDS) follow
// fontconfig's (fcweight.c's map; fcfreetype.c's weightConsts, widthConsts and slantConsts) entry by entry, so
// fontconfig's notice is kept beside this file: scripts/lib/fontconfig-notice.txt (THIRD_PARTY_NOTICES.md, "Code that
// follows other projects' code").
//
// What it follows, as fontconfig 2.13.96 built with its default options (no iconv) and TeX Live's FreeType
// (built --without-brotli, so WOFF2 files cannot be opened):
// - files: sfnt (TrueType, OpenType/CFF), TrueType and OpenType collections (each face by index), WOFF (zlib);
//   a file that cannot be read is left out, as fontconfig leaves out what FreeType cannot open; faces with no
//   outlines (no glyf, CFF or CFF2 table) are left out, as XeTeX lists only ":outline=true";
// - variable fonts: the default face, each named instance (index (instance << 16) | face) except one at the
//   default coordinates, and the variable face itself if a wght, wdth or opsz axis varies (fontconfig queries it
//   as instance 0x8000 and then records the face's own index, fcfreetype.c:1268-1323);
// - names: platforms in the order Microsoft, Unicode, Macintosh, ISO; name IDs 21, 16, 1 (family), 18, 4 (full
//   name), 22, 17, 2 (style), records sorted by encoding and language (US English first); UTF-16BE, Mac Roman,
//   ASCII and Latin-1 only (without iconv fontconfig drops the rest); spaces trimmed, empty names and names equal
//   to an earlier one ignoring spaces and case dropped; for a named instance the style is the instance's name
//   (fvar subfamilyNameID) and IDs 22, 17 and 4 are skipped; for the variable face only families;
// - fallbacks: no family gives the file name without its extension; no style gives FreeType's style name from
//   the style flags; no full name gives "family style" (the English ones);
// - weight and width from OS/2 (scaled by a named instance's wght and wdth), else from the style names; slant from
//   the style names, else FreeType's italic flag. Written as integers, as FcPatternGetInteger reads them.

import { inflateSync } from 'node:zlib';

const NAME = { FAMILY: 1, SUBFAMILY: 2, FULL: 4, PS: 6, TYPO_FAMILY: 16, TYPO_SUBFAMILY: 17, MAC_FULL: 18, WWS_FAMILY: 21, WWS_SUBFAMILY: 22, VAR_PS_PREFIX: 25 };
const PLATFORM_ORDER = [3, 0, 1, 2];
const NAMEID_ORDER = [21, 16, 1, 18, 4, 22, 17, 2];
const MS_ENGLISH_US = 0x0409;
const MAC_ENGLISH = 0;

// Apple's Mac Roman table, upper half (https://www.unicode.org/Public/MAPPINGS/VENDORS/APPLE/ROMAN.TXT).
const MAC_ROMAN_HIGH = [
  0x00c4, 0x00c5, 0x00c7, 0x00c9, 0x00d1, 0x00d6, 0x00dc, 0x00e1, 0x00e0, 0x00e2, 0x00e4, 0x00e3, 0x00e5, 0x00e7, 0x00e9, 0x00e8,
  0x00ea, 0x00eb, 0x00ed, 0x00ec, 0x00ee, 0x00ef, 0x00f1, 0x00f3, 0x00f2, 0x00f4, 0x00f6, 0x00f5, 0x00fa, 0x00f9, 0x00fb, 0x00fc,
  0x2020, 0x00b0, 0x00a2, 0x00a3, 0x00a7, 0x2022, 0x00b6, 0x00df, 0x00ae, 0x00a9, 0x2122, 0x00b4, 0x00a8, 0x2260, 0x00c6, 0x00d8,
  0x221e, 0x00b1, 0x2264, 0x2265, 0x00a5, 0x00b5, 0x2202, 0x2211, 0x220f, 0x03c0, 0x222b, 0x00aa, 0x00ba, 0x03a9, 0x00e6, 0x00f8,
  0x00bf, 0x00a1, 0x00ac, 0x221a, 0x0192, 0x2248, 0x2206, 0x00ab, 0x00bb, 0x2026, 0x00a0, 0x00c0, 0x00c3, 0x00d5, 0x0152, 0x0153,
  0x2013, 0x2014, 0x201c, 0x201d, 0x2018, 0x2019, 0x00f7, 0x25ca, 0x00ff, 0x0178, 0x2044, 0x20ac, 0x2039, 0x203a, 0xfb01, 0xfb02,
  0x2021, 0x00b7, 0x201a, 0x201e, 0x2030, 0x00c2, 0x00ca, 0x00c1, 0x00cb, 0x00c8, 0x00cd, 0x00ce, 0x00cf, 0x00cc, 0x00d3, 0x00d4,
  0xf8ff, 0x00d2, 0x00da, 0x00db, 0x00d9, 0x0131, 0x02c6, 0x02dc, 0x00af, 0x02d8, 0x02d9, 0x02da, 0x00b8, 0x02dd, 0x02db, 0x02c7,
];

// fontconfig's constants (fontconfig.h at 2.13.96).
const W = { THIN: 0, EXTRALIGHT: 40, LIGHT: 50, DEMILIGHT: 55, BOOK: 75, REGULAR: 80, MEDIUM: 100, DEMIBOLD: 180, BOLD: 200, EXTRABOLD: 205, BLACK: 210, EXTRABLACK: 215 };
const WIDTH = { ULTRACONDENSED: 50, EXTRACONDENSED: 63, CONDENSED: 75, SEMICONDENSED: 87, NORMAL: 100, SEMIEXPANDED: 113, EXPANDED: 125, EXTRAEXPANDED: 150, ULTRAEXPANDED: 200 };
const SLANT = { ROMAN: 0, ITALIC: 100, OBLIQUE: 110 };
const WEIGHT_MAP = [[0, W.THIN], [100, W.THIN], [200, W.EXTRALIGHT], [300, W.LIGHT], [350, W.DEMILIGHT], [380, W.BOOK], [400, W.REGULAR], [500, W.MEDIUM], [600, W.DEMIBOLD], [700, W.BOLD], [800, W.EXTRABOLD], [900, W.BLACK], [1000, W.EXTRABLACK]];
const WIDTH_CLASS = [null, WIDTH.ULTRACONDENSED, WIDTH.EXTRACONDENSED, WIDTH.CONDENSED, WIDTH.SEMICONDENSED, WIDTH.NORMAL, WIDTH.SEMIEXPANDED, WIDTH.EXPANDED, WIDTH.EXTRAEXPANDED, WIDTH.ULTRAEXPANDED];
const WEIGHT_WORDS = [['thin', W.THIN], ['extralight', W.EXTRALIGHT], ['ultralight', W.EXTRALIGHT], ['demilight', W.DEMILIGHT], ['semilight', W.DEMILIGHT], ['light', W.LIGHT], ['book', W.BOOK], ['regular', W.REGULAR], ['normal', W.REGULAR], ['medium', W.MEDIUM], ['demibold', W.DEMIBOLD], ['demi', W.DEMIBOLD], ['semibold', W.DEMIBOLD], ['extrabold', W.EXTRABOLD], ['superbold', W.EXTRABOLD], ['ultrabold', W.EXTRABOLD], ['bold', W.BOLD], ['ultrablack', W.EXTRABLACK], ['superblack', W.EXTRABLACK], ['extrablack', W.EXTRABLACK], ['<ultra', W.EXTRABOLD], ['black', W.BLACK], ['heavy', W.BLACK]];
const WIDTH_WORDS = [['ultracondensed', WIDTH.ULTRACONDENSED], ['extracondensed', WIDTH.EXTRACONDENSED], ['semicondensed', WIDTH.SEMICONDENSED], ['condensed', WIDTH.CONDENSED], ['normal', WIDTH.NORMAL], ['semiexpanded', WIDTH.SEMIEXPANDED], ['extraexpanded', WIDTH.EXTRAEXPANDED], ['ultraexpanded', WIDTH.ULTRAEXPANDED], ['expanded', WIDTH.EXPANDED], ['extended', WIDTH.EXPANDED]];
const SLANT_WORDS = [['italic', SLANT.ITALIC], ['kursiv', SLANT.ITALIC], ['oblique', SLANT.OBLIQUE]];

/** fontconfig's FcStrCmpIgnoreBlanksAndCase, as a key: spaces dropped, case folded. */
const fold = (s) => s.replace(/ /g, '').toLowerCase();

function containsWord(s, w) {
  const hay = s.toLowerCase();
  let i = hay.indexOf(w);
  while (i >= 0) {
    const before = i === 0 || !/[a-z0-9]/i.test(hay[i - 1]);
    const after = i + w.length >= hay.length || !/[a-z0-9]/i.test(hay[i + w.length]);
    if (before && after) return true;
    i = hay.indexOf(w, i + 1);
  }
  return false;
}

function containsConst(s, table) {
  const f = fold(s);
  for (const [word, value] of table) {
    if (word.startsWith('<') ? containsWord(s, word.slice(1)) : f.includes(word)) return value;
  }
  return -1;
}

function weightFromOpenType(ot) {
  if (ot < 0) return -1;
  ot = Math.min(ot, WEIGHT_MAP[WEIGHT_MAP.length - 1][0]);
  let i = 1;
  while (ot > WEIGHT_MAP[i][0]) i++;
  if (ot === WEIGHT_MAP[i][0]) return WEIGHT_MAP[i][1];
  const [x1, y1] = WEIGHT_MAP[i - 1];
  const [x2, y2] = WEIGHT_MAP[i];
  return y1 + ((y2 - y1) * (ot - x1)) / (x2 - x1);
}

// ---- reading the font file ----

function tag(b, o) {
  return b.toString('latin1', o, o + 4);
}

/** The table directory of the sfnt at offset `at` of `b` (a plain sfnt or one face of a collection). */
function sfntTables(b, at) {
  const numTables = b.readUInt16BE(at + 4);
  const tables = new Map();
  for (let i = 0; i < numTables; i++) {
    const r = at + 12 + 16 * i;
    const t = tag(b, r);
    const offset = b.readUInt32BE(r + 8);
    const length = b.readUInt32BE(r + 12);
    if (offset + length > b.length) throw new Error(`table ${t} lies outside the file`);
    tables.set(t, b.subarray(offset, offset + length));
  }
  return tables;
}

function woffTables(b) {
  const numTables = b.readUInt16BE(12);
  const tables = new Map();
  for (let i = 0; i < numTables; i++) {
    const r = 44 + 20 * i;
    const t = tag(b, r);
    const offset = b.readUInt32BE(r + 4);
    const compLength = b.readUInt32BE(r + 8);
    const origLength = b.readUInt32BE(r + 12);
    const raw = b.subarray(offset, offset + compLength);
    tables.set(t, compLength < origLength ? inflateSync(raw) : raw);
  }
  return tables;
}

/** The faces FreeType opens in a file: a list of table maps; [] if FreeType could not open it. */
export function readFaces(b) {
  if (b.length < 12) return { faces: [], reason: 'too short' };
  const sig = tag(b, 0);
  if (sig === 'ttcf') {
    const n = b.readUInt32BE(8);
    const faces = [];
    for (let i = 0; i < n; i++) faces.push(sfntTables(b, b.readUInt32BE(12 + 4 * i)));
    return { faces };
  }
  if (sig === '\x00\x01\x00\x00' || sig === 'OTTO' || sig === 'true' || sig === 'typ1') return { faces: [sfntTables(b, 0)] };
  if (sig === 'wOFF') return { faces: [woffTables(b)] };
  if (sig === 'wOF2') return { faces: [], reason: 'WOFF2 (TeX Live\'s FreeType has no Brotli)' };
  return { faces: [], reason: `not an sfnt (${JSON.stringify(sig)})` };
}

function nameRecords(name) {
  if (!name || name.length < 6) return [];
  const count = name.readUInt16BE(2);
  const storage = name.readUInt16BE(4);
  const recs = [];
  for (let i = 0; i < count; i++) {
    const r = 6 + 12 * i;
    if (r + 12 > name.length) break;
    const length = name.readUInt16BE(r + 8);
    const offset = name.readUInt16BE(r + 10);
    const start = storage + offset;
    if (start + length > name.length) continue; // FreeType drops a record outside the table
    recs.push({ platform: name.readUInt16BE(r), encoding: name.readUInt16BE(r + 2), language: name.readUInt16BE(r + 4), nameId: name.readUInt16BE(r + 6), bytes: name.subarray(start, start + length), idx: i });
  }
  const english = (r) => (r.platform === 1 && r.language === MAC_ENGLISH) || (r.platform === 3 && r.language === MS_ENGLISH_US);
  recs.sort((a, b) => a.platform - b.platform || a.nameId - b.nameId || a.encoding - b.encoding || (a.language !== b.language ? (english(a) ? -1 : english(b) ? 1 : a.language - b.language) : 0) || a.idx - b.idx);
  return recs;
}

function cutAtNul(s) {
  const i = s.indexOf('\u0000');
  return i >= 0 ? s.slice(0, i) : s;
}

function utf16be(bytes) {
  if (bytes.length % 2 !== 0) return null;
  let out = '';
  for (let i = 0; i < bytes.length; i += 2) {
    const a = bytes.readUInt16BE(i);
    if ((a & 0xfc00) === 0xd800) {
      if (i + 3 >= bytes.length) return null;
      const b = bytes.readUInt16BE(i + 2);
      if ((b & 0xfc00) !== 0xdc00) return null;
      out += String.fromCodePoint(((a & 0x3ff) << 10) + (b & 0x3ff) + 0x10000);
      i += 2;
    } else out += String.fromCharCode(a);
  }
  return out;
}

const latin1 = (bytes) => bytes.toString('latin1');
const macRoman = (bytes) => Array.from(bytes, (c) => String.fromCharCode(c < 128 ? c : MAC_ROMAN_HIGH[c - 128])).join('');

function looksLikeSjis(bytes) {
  let high = 0;
  let low = 0;
  for (const c of bytes) (c & 0x80 ? high++ : low++);
  return high * 2 > low;
}

/** fontconfig's FcSfntNameTranscode without iconv: the name as text, or null when it is dropped. */
function transcode(r) {
  let s = null;
  if (r.platform === 0) s = utf16be(r.bytes);
  else if (r.platform === 3 && (r.encoding === 0 || r.encoding === 1 || r.encoding === 10)) s = utf16be(r.bytes);
  else if (r.platform === 2 && r.encoding === 1) s = utf16be(r.bytes);
  else if (r.platform === 2 && (r.encoding === 0 || r.encoding === 2)) s = latin1(r.bytes);
  else if (r.platform === 1 && r.encoding === 0) {
    if (r.language === MAC_ENGLISH && looksLikeSjis(r.bytes)) s = null; // SJIS needs iconv
    else if (r.language >= 0x100) s = r.language === MS_ENGLISH_US ? latin1(r.bytes) : null;
    else s = macRoman(r.bytes);
  }
  if (s === null) return null;
  s = cutAtNul(s);
  return fold(s) === '' ? null : s;
}

function os2Info(t) {
  if (!t || t.length < 8) return null;
  const version = t.readUInt16BE(0);
  return { version, weightClass: t.readUInt16BE(4), widthClass: t.readUInt16BE(6), fsSelection: t.length >= 64 ? t.readUInt16BE(62) : 0 };
}

function fvarInfo(t) {
  if (!t || t.length < 16) return null;
  const axesOffset = t.readUInt16BE(4);
  const axisCount = t.readUInt16BE(8);
  const axisSize = t.readUInt16BE(10);
  const instanceCount = t.readUInt16BE(12);
  const instanceSize = t.readUInt16BE(14);
  const axes = [];
  for (let i = 0; i < axisCount; i++) {
    const o = axesOffset + i * axisSize;
    axes.push({ tag: tag(t, o), min: t.readInt32BE(o + 4) / 65536, def: t.readInt32BE(o + 8) / 65536, max: t.readInt32BE(o + 12) / 65536, defFixed: t.readInt32BE(o + 8) });
  }
  const instances = [];
  const first = axesOffset + axisCount * axisSize;
  for (let i = 0; i < instanceCount; i++) {
    const o = first + i * instanceSize;
    if (o + 4 + 4 * axisCount > t.length) break;
    const coords = axes.map((_, a) => t.readInt32BE(o + 4 + 4 * a) / 65536);
    const psid = instanceSize >= 6 + 4 * axisCount ? t.readUInt16BE(o + 4 + 4 * axisCount) : null;
    const coordsFixed = axes.map((_, a) => t.readInt32BE(o + 4 + 4 * a));
    instances.push({ strid: t.readUInt16BE(o), coords, coordsFixed, psid });
  }
  return { axes, instances };
}

/** FreeType's style flags of an sfnt face: { bold, italic }. */
function styleFlags(tables) {
  const os2 = os2Info(tables.get('OS/2'));
  if (os2 && os2.version !== 0xffff) return { italic: Boolean(os2.fsSelection & 0x201), bold: Boolean(os2.fsSelection & 0x20) };
  const head = tables.get('head');
  const mac = head && head.length >= 46 ? head.readUInt16BE(44) : 0;
  return { bold: Boolean(mac & 1), italic: Boolean(mac & 2) };
}

/** PostScript-name characters FreeType keeps (sfnt_get_ps_name: printable ASCII without the delimiters). */
function psClean(s) {
  if (s === null) return null;
  for (const c of s) {
    const x = c.codePointAt(0);
    if (x < 33 || x > 126 || '[](){}<>/%'.includes(c)) return null;
  }
  return s;
}

function psName(recs, instance, names, fvar) {
  if (instance === null) {
    for (const p of [3, 1]) {
      const r = recs.find((x) => x.platform === p && x.nameId === NAME.PS && (p === 3 ? x.encoding === 1 || x.encoding === 0 || x.encoding === 10 : x.encoding === 0));
      if (r) {
        const s = psClean(cutAtNul(p === 3 ? utf16be(r.bytes) ?? '' : macRoman(r.bytes)));
        if (s) return s;
      }
    }
    return null;
  }
  // A named instance. fontconfig 2.13.96 opens the face plain and sets the instance's coordinates
  // (fcfreetype.c:2322, FT_Set_Var_Design_Coordinates), so FreeType sees a variation, not a named instance, and
  // builds the name from the axis values: the prefix, then "_<value><tag>" for each axis off its default
  // (TeX Live's FreeType 2.14.1, src/sfnt/sfdriver.c, sfnt_get_var_ps_name). The instance's own postScriptNameID is
  // not used on that path. A name over 127 characters would become a hash there; such a face is not supported.
  if (!fvar || !instance.coordsFixed) return null;
  const prefix = varPrefix(recs);
  if (prefix === null) return null;
  let name = prefix;
  fvar.axes.forEach((a, i) => {
    if (instance.coordsFixed[i] === a.defFixed) return;
    name += `_${fixed2float(instance.coordsFixed[i])}${[...a.tag].filter((c) => c !== ' ' && /[A-Za-z0-9]/.test(c)).join('')}`;
  });
  return name.length > 127 ? null : name;
}

/**
 * FreeType's prefix of a variation's PostScript name: name ID 25, else 16, else 1 (the first that has a record), the
 * Windows record (the last in US English, else the first), else the Apple one, its letters and digits only, at
 * most 91 characters (sfnt_get_var_ps_name, sfnt_get_name_id, get_win_string, get_apple_string).
 */
function varPrefix(recs) {
  const raw = recs.slice().sort((a, b) => a.idx - b.idx);
  const alnum = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
  for (const id of [NAME.VAR_PS_PREFIX, NAME.TYPO_FAMILY, NAME.FAMILY]) {
    let win = null;
    let apple = null;
    for (const r of raw) {
      if (r.nameId !== id || r.bytes.length === 0) continue;
      if (r.platform === 3 && (r.encoding === 1 || r.encoding === 0) && (r.language === MS_ENGLISH_US || win === null)) win = r;
      if (r.platform === 1 && r.encoding === 0 && (r.language === 0 || apple === null)) apple = r;
    }
    if (!win && !apple) continue;
    let s = '';
    if (win) for (let i = 0; i + 1 < win.bytes.length; i += 2) if (win.bytes[i] === 0 && alnum(win.bytes[i + 1])) s += String.fromCharCode(win.bytes[i + 1]);
    if (!s && apple) for (const b of apple.bytes) if (alnum(b)) s += String.fromCharCode(b);
    return s ? s.slice(0, 127 - 36) : null;
  }
  return null;
}

/** FreeType's shortest decimal form of a 16.16 fixed-point number (sfdriver.c, fixed2float), digit for digit. */
export function fixed2float(fixed) {
  if (fixed === 0) return '0';
  let out = '';
  let f = fixed;
  if (f < 0) {
    out = '-';
    f = -f;
  }
  const intPart = (f >> 16) & 0xffff;
  let frac = f & 0xffff;
  if (intPart > 0) out += String(intPart);
  if (!frac) return out;
  const d = [];
  frac = frac * 10 + 5;
  for (let i = 0; i < 5; i++) {
    d.push(Math.floor(frac / 0x10000));
    frac %= 0x10000;
    if (!frac) break;
    frac *= 10;
  }
  if (d.length === 5) {
    if (frac < 34480 * 10 && d[4] === 1) d[4] = 0;
    else if (frac === 17232 * 10 && d[4] & 1) d[4] -= 1;
    else if (frac < 17232 * 10 && d[4] !== 0) d[4] -= 1;
  }
  while (d.length > 0 && d[d.length - 1] === 0) d.pop();
  return `${out}.${d.join('')}`;
}

/** One face (or instance) as fontconfig 2.13.96 would describe it. `mode`: null, an instance, or 'variable'. */
function describe(tables, recs, fileBase, mode, fvar) {
  const variable = mode === 'variable';
  const instance = mode && mode !== 'variable' ? mode : null;
  const out = { family: [], style: [], full: [] };
  const seen = { family: new Set(), style: new Set(), full: new Set() };
  for (const platform of PLATFORM_ORDER) {
    for (const nameid of NAMEID_ORDER) {
      let lookup = nameid;
      if (instance) {
        if (nameid === NAME.WWS_SUBFAMILY || nameid === NAME.TYPO_SUBFAMILY || nameid === NAME.FULL) continue;
        if (nameid === NAME.SUBFAMILY) lookup = instance.strid;
      }
      let kind;
      if (nameid === NAME.WWS_FAMILY || nameid === NAME.TYPO_FAMILY || nameid === NAME.FAMILY) kind = 'family';
      else if (nameid === NAME.MAC_FULL || nameid === NAME.FULL) kind = variable ? null : 'full';
      else kind = variable ? null : 'style';
      if (kind === null) continue;
      for (const r of recs) {
        if (r.platform !== platform || r.nameId !== lookup) continue;
        let s = transcode(r);
        if (s === null) continue;
        s = s.replace(/^ +/, '').replace(/ +$/, '');
        const k = fold(s);
        if (seen[kind].has(k)) continue;
        seen[kind].add(k);
        out[kind].push(s);
      }
    }
  }
  const flags = styleFlags(tables);
  if (out.family.length === 0) {
    // (FreeType's own family name would come first; it reads the same records, so it is empty here too.)
    const dot = fileBase.lastIndexOf('.');
    out.family.push(dot > 0 ? fileBase.slice(0, dot) : fileBase);
  }
  if (!variable && out.style.length === 0) {
    out.style.push(flags.bold && flags.italic ? 'Bold Italic' : flags.bold ? 'Bold' : flags.italic ? 'Italic' : 'Regular');
  }
  if (!variable && out.full.length === 0) out.full.push(`${out.family[0].replace(/\s+$/, '')} ${out.style[0].replace(/^\s+/, '')}`);
  // fontconfig's characters a PostScript name may not hold (fcfreetype.c:1772), 0x04 among them.
  // eslint-disable-next-line no-control-regex
  const ps = variable ? null : psName(recs, instance, out, fvar) ?? out.family[0].replace(/[\x04()/<>[\]{}\t\f\r\n ]/g, '-').slice(0, 255);

  let weightMult = 1;
  let widthMult = 1;
  if (instance && fvar) {
    fvar.axes.forEach((a, i) => {
      const mult = a.def ? instance.coords[i] / a.def : 1;
      if (a.tag === 'wght') weightMult = mult;
      if (a.tag === 'wdth') widthMult = mult;
    });
  }
  let weight = -1;
  let width = -1;
  let slant = -1;
  let variableWeight = false;
  let variableWidth = false;
  if (variable) {
    for (const a of fvar.axes) {
      if (a.min > a.def || a.def > a.max || a.min === a.max) continue;
      if (a.tag === 'wght') {
        variableWeight = true;
        weight = 0;
      }
      if (a.tag === 'wdth') {
        variableWidth = true;
        width = 0;
      }
    }
  }
  const os2 = os2Info(tables.get('OS/2'));
  if (os2 && os2.version !== 0xffff) {
    if (!variableWeight) weight = weightFromOpenType(os2.weightClass * weightMult);
    if (!variableWidth) {
      width = WIDTH_CLASS[os2.widthClass] ?? -1;
      width *= widthMult;
    }
  }
  for (const st of out.style) {
    if (weight === -1) weight = containsConst(st, WEIGHT_WORDS);
    if (width === -1) width = containsConst(st, WIDTH_WORDS);
    if (slant === -1) slant = containsConst(st, SLANT_WORDS);
  }
  if (slant === -1) slant = flags.italic ? SLANT.ITALIC : SLANT.ROMAN;
  if (weight === -1) weight = flags.bold ? W.BOLD : W.MEDIUM;
  if (width === -1) width = WIDTH.NORMAL;
  // The face's own family and subfamily (name IDs 1 and 2, the first English record of each): not in the list; the
  // font check uses them to pick a face for a name no engine resolves.
  const own = (id) => {
    const r = recs.find((x) => x.nameId === id && (x.platform === 3 ? x.language === MS_ENGLISH_US : x.platform === 1 ? x.language === MAC_ENGLISH : false));
    const t = r ? transcode(r) : null;
    return t === null ? null : t.trim();
  };
  const legacy = [own(NAME.FAMILY), own(NAME.SUBFAMILY)].filter(Boolean).join(' ') || null;
  return {
    family: out.family,
    style: out.style,
    full: out.full,
    postscript: ps,
    legacy,
    weight: variableWeight ? null : Math.trunc(weight),
    width: variableWidth ? null : Math.trunc(width),
    slant,
  };
}

const scalable = (tables) => tables.has('glyf') || tables.has('CFF ') || tables.has('CFF2');

/**
 * Every face fontconfig 2.13.96 lists for one font file, in its order (face by face; for each face the default,
 * then the named instances, then the variable face). `file` is the path written into the list.
 */
export function describeFile(bytes, file) {
  let opened;
  try {
    opened = readFaces(bytes);
  } catch (e) {
    return { faces: [], skipped: `cannot be read: ${e.message}` };
  }
  if (opened.faces.length === 0) return { faces: [], skipped: opened.reason };
  const base = file.slice(file.lastIndexOf('/') + 1);
  const faces = [];
  let variable = false;
  opened.faces.forEach((tables, faceIndex) => {
    if (!scalable(tables)) return;
    const recs = nameRecords(tables.get('name'));
    const fvar = fvarInfo(tables.get('fvar'));
    if (fvar) variable = true;
    const push = (index, mode) => faces.push({ file, index, ...describe(tables, recs, base, mode, fvar) });
    push(faceIndex, null);
    if (fvar && fvar.instances.length > 0) {
      fvar.instances.forEach((inst, i) => {
        const atDefault = inst.coords.every((c, a) => c === fvar.axes[a].def);
        if (!atDefault) push(((i + 1) << 16) + faceIndex, inst);
      });
      const varies = fvar.axes.some((a) => ['wght', 'wdth', 'opsz'].includes(a.tag) && !(a.min > a.def || a.def > a.max || a.min === a.max));
      if (varies) push(faceIndex, 'variable');
    } else if (fvar) {
      const varies = fvar.axes.some((a) => ['wght', 'wdth', 'opsz'].includes(a.tag) && !(a.min > a.def || a.def > a.max || a.min === a.max));
      if (varies) push(faceIndex, 'variable');
    }
  });
  return { faces, variable };
}

const SEP = '\x1f';
// The list's separators (tab, newline, 0x1F) never appear inside a name.
// eslint-disable-next-line no-control-regex
const clean = (s) => s.replace(/[\t\n\r\x1f]/g, ' ');

/** One line of the list (engine/build/fontlist/fontlist.c says the format). */
export function listLine(f, root = '') {
  return [
    `${root}${f.file}`,
    String(f.index | 0),
    f.family.map(clean).join(SEP),
    f.style.map(clean).join(SEP),
    f.full.map(clean).join(SEP),
    f.postscript === null ? '' : clean(f.postscript),
    f.weight === null ? '' : String(f.weight),
    f.width === null ? '' : String(f.width),
    String(f.slant),
  ].join('\t');
}

/** The names XeTeX's lookup can meet first for a face: PostScript, full names, and family plus style. */
function collisionKeys(f) {
  const keys = [];
  if (f.postscript) keys.push(['postscript name', f.postscript]);
  for (const n of f.full) keys.push(['full name', n]);
  for (const fam of f.family) for (const st of f.style) keys.push(['family and style', `${fam} ${st}`]);
  return keys;
}

/**
 * Orders the faces of one data set (by file path in byte order, then as each file lists them) and applies its
 * fontOrder rules ([{ name, first }]: the face whose file is `first` comes before every other face that shares
 * `name`). Returns the faces, every collision (each with the rule that decides it, or none), and the rules that
 * do not hold at the end: `unmetRules` (another file's face still comes first for the name) and `staleRules`
 * (the rule's file holds no face with the name, or no other file shares it, so the rule decides nothing).
 */
export function orderFaces(faces, rules = []) {
  const byPath = (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  const sorted = faces.map((f, i) => ({ f, i })).sort((a, b) => byPath(a.f, b.f) || a.i - b.i).map((x) => x.f);
  const holds = (f, name) => collisionKeys(f).some(([, n]) => n === name);
  for (const rule of rules) {
    const firstAt = sorted.findIndex((f) => f.file === rule.first && holds(f, rule.name));
    if (firstAt < 0) continue;
    const firstIdx = sorted.findIndex((f) => holds(f, rule.name));
    if (firstIdx >= 0 && firstIdx < firstAt) {
      const [face] = sorted.splice(firstAt, 1);
      sorted.splice(firstIdx, 0, face);
    }
  }
  const unmetRules = [];
  const staleRules = [];
  for (const rule of rules) {
    const holders = sorted.filter((f) => holds(f, rule.name));
    if (!holders.some((f) => f.file === rule.first)) staleRules.push({ ...rule, why: 'no face of its file has the name' });
    else if (new Set(holders.map((f) => f.file)).size < 2) staleRules.push({ ...rule, why: 'no other file has the name' });
    else if (holders[0].file !== rule.first) unmetRules.push({ ...rule, firstNow: holders[0].file });
  }
  return { faces: sorted, collisions: collisionsOf(sorted, rules), unmetRules, staleRules };
}

function collisionsOf(sorted, rules = []) {
  const seen = new Map();
  const collisions = [];
  for (const f of sorted) {
    for (const [kind, name] of collisionKeys(f)) {
      const key = `${kind}\u0000${name}`;
      const prev = seen.get(key);
      if (prev && prev.file !== f.file) {
        const rule = rules.find((r) => r.name === name) ?? null;
        collisions.push({ kind, name, first: prev.file, firstIndex: prev.index, other: f.file, otherIndex: f.index, rule });
      } else if (!prev) seen.set(key, f);
    }
  }
  return collisions;
}

/**
 * The list as the host writes it: each data set's list on its own, ordered
 * with that set's rules, then the lists joined in mount order (core-data first). A rule belongs to the set that
 * holds its `first` file. A name that faces of two sets share is a cross-set collision: the joining order decides
 * it and no rule of a set can, so the builder fails on one.
 * @param {{ name: string, faces: object[] }[]} sets in mount order
 */
export function joinSets(sets, rules = []) {
  const parts = sets.map((set) => {
    const files = new Set(set.faces.map((f) => f.file));
    return { name: set.name, ...orderFaces(set.faces, rules.filter((r) => files.has(r.first))) };
  });
  const placed = new Set(sets.flatMap((set) => set.faces.map((f) => f.file)));
  const strayRules = rules.filter((r) => !placed.has(r.first)).map((r) => ({ ...r, why: 'no set holds its file' }));
  const owner = new Map();
  const crossSet = [];
  for (const part of parts) {
    const here = new Map();
    for (const f of part.faces) {
      for (const [kind, name] of collisionKeys(f)) {
        const key = `${kind}\u0000${name}`;
        const prev = owner.get(key);
        if (prev && prev.set !== part.name && !crossSet.some((c) => c.key === key && c.other === f.file)) {
          crossSet.push({ key, kind, name, firstSet: prev.set, first: prev.file, otherSet: part.name, other: f.file });
        }
        if (!here.has(key)) here.set(key, { set: part.name, file: f.file });
      }
    }
    for (const [k, v] of here) if (!owner.has(k)) owner.set(k, v);
  }
  return {
    faces: parts.flatMap((p) => p.faces),
    collisions: parts.flatMap((p) => p.collisions.map((c) => ({ ...c, set: p.name }))),
    crossSet: crossSet.map((c) => ({ kind: c.kind, name: c.name, firstSet: c.firstSet, first: c.first, otherSet: c.otherSet, other: c.other })),
    unmetRules: parts.flatMap((p) => p.unmetRules),
    staleRules: [...parts.flatMap((p) => p.staleRules), ...strayRules],
  };
}

/** The font files of a data set that the list covers: everything under fonts/opentype/ and fonts/truetype/. */
export function isListedFontPath(rel) {
  return /(^|\/)fonts\/(opentype|truetype)\//.test(rel);
}
