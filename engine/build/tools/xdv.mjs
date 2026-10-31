// engine/build/tools/xdv.mjs: reads the pages and native font definitions of an XDV file (XeTeX's extended DVI,
// id byte 7). Used by font-check.mjs to learn which file and face XeTeX chose for each font request
// (its check 2).
//
// Ours (the liveMd2Tex authors), GPL-3.0-or-later. The opcodes are DVI's (TeX Live 6a300188,
// texk/web2c/xetexdir/xetex.web, sections "Device-independent file format", lines 13880-13935) and XeTeX's three:
// define_native_font 252 (k[4] size[4] flags[2] l[1] name[l] index[4], then rgba[4], extend[4], slant[4] and
// embolden[4] as the flags say; XeTeX_ext.c:1501-1505, 1583-1720), set_glyphs 253 (w[4] n[2] xy[8n] g[2n]) and
// set_text_and_glyphs 254 (l[2] t[2l] w[4] n[2] xy[8n] g[2n]).

const FLAG_COLORED = 0x0200;
const FLAG_EXTEND = 0x1000;
const FLAG_SLANT = 0x2000;
const FLAG_EMBOLDEN = 0x4000;

/**
 * Parses an XDV file. Returns { fonts: Map(k -> { name, index, size, flags }), pages: [{ counts: [c0..c9],
 * fonts: [k used on the page, in order] }] }.
 */
export function readXdv(buf) {
  const b = Buffer.from(buf);
  let p = 0;
  const u = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 256 + b[p++];
    return v;
  };
  const s32 = () => {
    const v = b.readInt32BE(p);
    p += 4;
    return v;
  };
  const fonts = new Map();
  const pages = [];
  let page = null;
  const select = (k) => {
    if (page && page.fonts[page.fonts.length - 1] !== k) page.fonts.push(k);
  };
  while (p < b.length) {
    const op = b[p++];
    if (op <= 127) continue;
    if (op >= 171 && op <= 234) {
      select(op - 171);
      continue;
    }
    switch (op) {
      case 128: case 129: case 130: case 131: p += op - 127; break; // set1-4
      case 132: case 137: p += 8; break; // set_rule, put_rule
      case 133: case 134: case 135: case 136: p += op - 132; break; // put1-4
      case 138: case 140: case 141: case 142: case 147: case 152: case 161: case 166: // nop eop push pop w0 x0 y0 z0
        if (op === 140) page = null;
        break;
      case 139: {
        const counts = [];
        for (let i = 0; i < 10; i++) counts.push(s32());
        p += 4;
        page = { counts, fonts: [] };
        pages.push(page);
        break;
      }
      case 143: case 144: case 145: case 146: p += op - 142; break; // right1-4
      case 148: case 149: case 150: case 151: p += op - 147; break; // w1-4
      case 153: case 154: case 155: case 156: p += op - 152; break; // x1-4
      case 157: case 158: case 159: case 160: p += op - 156; break; // down1-4
      case 162: case 163: case 164: case 165: p += op - 161; break; // y1-4
      case 167: case 168: case 169: case 170: p += op - 166; break; // z1-4
      case 235: case 236: case 237: case 238: select(u(op - 234)); break; // fnt1-4
      case 239: case 240: case 241: case 242: { const k = u(op - 238); p += k; break; } // xxx1-4
      case 243: case 244: case 245: case 246: { // fnt_def1-4: a TFM font
        const k = u(op - 242);
        p += 12;
        const a = b[p++];
        const l = b[p++];
        const name = b.toString('latin1', p + a, p + a + l);
        p += a + l;
        fonts.set(k, { name, index: null, size: null, flags: 0, tfm: true });
        break;
      }
      case 247: { p += 13; const k = b[p++]; p += k; break; } // pre
      case 248: p += 28; break; // post
      case 249: p = b.length; break; // post_post: the rest is the trailer
      case 252: {
        const k = s32();
        const size = s32();
        const flags = b.readUInt16BE(p);
        p += 2;
        const l = b[p++];
        const name = b.toString('utf8', p, p + l);
        p += l;
        const index = b.readUInt32BE(p) | 0;
        p += 4;
        if (flags & FLAG_COLORED) p += 4;
        if (flags & FLAG_EXTEND) p += 4;
        if (flags & FLAG_SLANT) p += 4;
        if (flags & FLAG_EMBOLDEN) p += 4;
        fonts.set(k, { name, index, size, flags });
        break;
      }
      case 253: { p += 4; const n = b.readUInt16BE(p); p += 2 + 10 * n; break; }
      case 254: { const l = b.readUInt16BE(p); p += 2 + 2 * l + 4; const n = b.readUInt16BE(p); p += 2 + 10 * n; break; }
      default:
        throw new Error(`unknown XDV opcode ${op} at byte ${p - 1}`);
    }
  }
  return { fonts, pages };
}

/** For each page number (\count0), the native font (file, index) its first glyph used, or null. */
export function chosenFonts(buf) {
  const { fonts, pages } = readXdv(buf);
  const out = new Map();
  for (const pg of pages) {
    const k = pg.fonts.find((x) => fonts.has(x) && !fonts.get(x).tfm);
    out.set(pg.counts[0], k === undefined ? null : { file: fonts.get(k).name, index: fonts.get(k).index });
  }
  return out;
}
