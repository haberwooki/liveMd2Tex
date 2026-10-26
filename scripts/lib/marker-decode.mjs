// The decoded views of a text that the private-marker scan searches besides the text itself (build gate 2,
// G2R-01): what a file says once its escapes, base64, base32 (build gate 3, G3S-05), hex, percent encoding,
// character-code lists, UTF-16 and ROT13 are undone. A marker hidden in any of them is then found by the same case-insensitive search and word
// rules as in plain text. Decoded runs of base64 and hex count only when they read as text (85 % printable ASCII;
// the markers are ASCII), so random hashes never turn into findings.

const printable = (s) => {
  if (s.length === 0) {
    return false;
  }
  let p = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c >= 32 && c < 127) || c === 9 || c === 10 || c === 13) {
      p++;
    }
  }
  return p / s.length >= 0.85;
};

/** A function from a character index to its line number (1-based), by binary search over the line starts. */
function lineFinder(text) {
  const starts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) {
    starts.push(i + 1);
  }
  return (index) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= index) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return lo + 1;
  };
}

/** A byte string read as Latin-1, as UTF-16 little-endian and as UTF-16 big-endian. */
function textsOf(bytes) {
  const out = [{ how: '', text: bytes.toString('latin1') }];
  const utf8 = bytes.toString('utf8');
  if (!utf8.includes('�')) {
    out.push({ how: '', text: utf8 });
  }
  if (bytes.length >= 4) {
    for (const start of [0, 1]) {
      const even = bytes.subarray(start, start + ((bytes.length - start) & ~1));
      out.push({ how: ' as UTF-16LE', text: even.toString('utf16le') });
      out.push({ how: ' as UTF-16BE', text: Buffer.from(even).swap16().toString('utf16le') });
    }
  }
  return out.filter((t) => printable(t.text));
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** The bytes of a base32 string (RFC 4648, any case, no padding); a trailing part of a byte is dropped. */
function base32Bytes(s) {
  const out = [];
  let value = 0;
  let bits = 0;
  for (const ch of s.toUpperCase()) {
    value = (value << 5) | BASE32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 255);
      value &= (1 << bits) - 1;
    }
  }
  return Buffer.from(out);
}

const rot13 = (s) => s.replace(/[A-Za-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) & 31) + 12) % 26 + (c <= 'Z' ? 65 : 97)));

/**
 * The decoded views of `text`: { kind, line, text } (line: where the encoded run starts; 0 for a whole-text view,
 * whose own line numbers are those of the file).
 */
export function decodedViews(text) {
  const views = [];
  const lineAt = lineFinder(text);
  // Escapes in code and markup: \uXXXX, \u{X}, \xXX, &#NNN;, &#xHH; (line structure kept).
  const unescaped = text.replace(/\\u\{([0-9a-fA-F]{1,6})\}|\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})|&#x([0-9a-fA-F]{1,6});|&#([0-9]{1,7});/g, (m, a, b, c, d, e) => {
    const code = e !== undefined ? parseInt(e, 10) : parseInt(a ?? b ?? c ?? d, 16);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
  if (unescaped !== text) {
    views.push({ kind: 'escapes', line: 0, text: unescaped });
  }
  // UTF-16 text in a file read byte by byte: every other byte is a zero.
  if (text.includes('\0')) {
    views.push({ kind: 'UTF-16', line: 0, text: text.replace(/\0/g, '') });
  }
  views.push({ kind: 'ROT13', line: 0, text: rot13(text) });
  // base64 runs, standard and URL-safe, read from each of the four starting characters.
  for (const m of text.matchAll(/[A-Za-z0-9+/_-]{8,}={0,2}/g)) {
    const run = m[0].replace(/-/g, '+').replace(/_/g, '/');
    for (let drop = 0; drop < 4; drop++) {
      const part = run.slice(drop).replace(/=+$/, '');
      const usable = part.slice(0, part.length - (part.length % 4 === 1 ? 1 : 0));
      for (const t of textsOf(Buffer.from(usable, 'base64'))) {
        views.push({ kind: `base64${t.how}`, line: lineAt(m.index), text: t.text });
      }
    }
  }
  // base32 runs, read from each of the eight starting characters: upper case, or lower case with a digit (a
  // lower-case run without one is an ordinary word far more often).
  for (const m of text.matchAll(/[A-Za-z2-7]{8,}/g)) {
    const run = m[0];
    if (!/^[A-Z2-7]+$/.test(run) && !(/^[a-z2-7]+$/.test(run) && /[2-7]/.test(run))) {
      continue;
    }
    for (let drop = 0; drop < 8; drop++) {
      for (const t of textsOf(base32Bytes(run.slice(drop)))) {
        views.push({ kind: `base32${t.how}`, line: lineAt(m.index), text: t.text });
      }
    }
  }
  // hex runs, from either nibble.
  // A run of decimal digits is a number far more often than hex, and its pairs read as letters often enough to
  // spell a short word by chance: such a view is "weak", searched only for markers of five or more characters.
  for (const m of text.matchAll(/[0-9a-fA-F]{8,}/g)) {
    const weak = /^[0-9]+$/.test(m[0]);
    for (const start of [0, 1]) {
      const hex = m[0].slice(start, start + ((m[0].length - start) & ~1));
      for (const t of textsOf(Buffer.from(hex, 'hex'))) {
        views.push({ kind: `hex${t.how}`, line: lineAt(m.index), text: t.text, weak });
      }
    }
  }
  // Percent encoding.
  for (const m of text.matchAll(/(?:%[0-9a-fA-F]{2}){3,}/g)) {
    const bytes = Buffer.from(m[0].replace(/%/g, ''), 'hex');
    for (const t of textsOf(bytes)) {
      views.push({ kind: `percent${t.how}`, line: lineAt(m.index), text: t.text });
    }
  }
  // Lists of character codes: 112, 117, 114, ...
  for (const m of text.matchAll(/\b(?:\d{2,3}\s*,\s*){3,}\d{2,3}\b/g)) {
    const codes = m[0].split(/\s*,\s*/).map(Number);
    if (codes.every((c) => c >= 32 && c <= 126)) {
      views.push({ kind: 'character codes', line: lineAt(m.index), text: codes.map((c) => String.fromCharCode(c)).join('') });
    }
  }
  return views;
}
