// A tar reader (B1; docs/DESIGN.md#engine-and-data): TeX Live's per-package archives are tar files, xz-compressed
// (scripts/lib/xz.mjs). It reads ustar and GNU tar as TeX Live's tools write them: plain files, folders, symbolic
// links, GNU long names (type L and K) and pax headers (type x and g, for long paths and sizes). Every header's
// checksum is checked; a file that would land outside the archive's root is refused.

const BLOCK = 512;

function text(b, start, len) {
  let end = start;
  while (end < start + len && b[end] !== 0) {
    end++;
  }
  return Buffer.from(b.subarray(start, end)).toString('utf8');
}

/** A numeric header field: octal text, or GNU base-256 when the top bit of the first byte is set. */
function number(b, start, len) {
  if (b[start] & 0x80) {
    let n = 0;
    for (let i = start + 1; i < start + len; i++) {
      n = n * 256 + b[i];
    }
    return n;
  }
  const s = text(b, start, len).trim();
  return s === '' ? 0 : parseInt(s, 8);
}

/** pax records: "<len> <key>=<value>\n", repeated. */
function pax(bytes) {
  const out = {};
  const b = Buffer.from(bytes);
  let pos = 0;
  while (pos < b.length) {
    const space = b.indexOf(0x20, pos);
    const len = space > pos ? parseInt(b.subarray(pos, space).toString('latin1'), 10) : NaN;
    if (!(len > 0) || pos + len > b.length) {
      break;
    }
    // The length counts bytes, the record included; the record ends with a newline.
    const record = b.subarray(space + 1, pos + len - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq > 0) {
      out[record.slice(0, eq)] = record.slice(eq + 1);
    }
    pos += len;
  }
  return out;
}

/** "a/./b/../c" to "a/c", with "/" only; null when it would leave the root or is absolute. */
export function safePath(p) {
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) {
    return null;
  }
  const parts = [];
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') {
      continue;
    }
    if (seg === '..') {
      if (parts.length === 0) {
        return null;
      }
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.join('/');
}

/**
 * The entries of a tar archive: [{ path, type: 'file' | 'dir' | 'symlink' | 'hardlink', data?, link?, mode }].
 * @param {Uint8Array} tar
 */
export function readTar(tar) {
  const entries = [];
  let pos = 0;
  let longName;
  let longLink;
  let local = {};
  let global = {};
  while (pos + BLOCK <= tar.length) {
    const h = tar.subarray(pos, pos + BLOCK);
    if (h.every((b) => b === 0)) {
      break; // the end: two zero blocks (one is enough to stop)
    }
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) {
      sum += i >= 148 && i < 156 ? 32 : h[i];
    }
    if (sum !== number(h, 148, 8)) {
      throw new Error(`tar: a damaged header at byte ${pos}`);
    }
    const type = String.fromCharCode(h[156] || 0x30);
    const size = local.size !== undefined ? Number(local.size) : global.size !== undefined ? Number(global.size) : number(h, 124, 12);
    const dataStart = pos + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) {
      throw new Error('tar: the archive ends inside a file');
    }
    const data = tar.subarray(dataStart, dataEnd);
    pos = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'L') {
      longName = text(data, 0, data.length);
      continue;
    }
    if (type === 'K') {
      longLink = text(data, 0, data.length);
      continue;
    }
    if (type === 'x') {
      local = pax(data);
      continue;
    }
    if (type === 'g') {
      global = { ...global, ...pax(data) };
      continue;
    }
    const prefix = h[257] === 0x75 /* "ustar" */ ? text(h, 345, 155) : '';
    const name = longName ?? local.path ?? global.path ?? (prefix ? `${prefix}/${text(h, 0, 100)}` : text(h, 0, 100));
    const link = longLink ?? local.linkpath ?? global.linkpath ?? text(h, 157, 100);
    longName = undefined;
    longLink = undefined;
    local = {};
    const path = safePath(name);
    if (path === null) {
      throw new Error(`tar: a path outside the archive: ${name}`);
    }
    const mode = number(h, 100, 8);
    if (type === '0' || type === '7') {
      entries.push({ path, type: 'file', data, mode });
    } else if (type === '5') {
      entries.push({ path, type: 'dir', mode });
    } else if (type === '2') {
      entries.push({ path, type: 'symlink', link, mode });
    } else if (type === '1') {
      const target = safePath(link);
      if (target === null) {
        throw new Error(`tar: a hard link outside the archive: ${link}`);
      }
      entries.push({ path, type: 'hardlink', link: target, mode });
    }
    // Other types (devices, FIFOs) carry no file and are left out.
  }
  return entries;
}
