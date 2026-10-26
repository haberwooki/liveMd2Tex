// A tiny ustar writer for the bundle builder's tests (B1): plain files and folders, as TeX Live's archives hold them.

const header = (name: string, size: number, type: string): Buffer => {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  h.write('00000000000\0', 136);
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of h) {
    sum += b;
  }
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return h;
};

/** A tar archive of `files` (path -> text or bytes). */
export function tarArchive(files: Record<string, string | Uint8Array>): Buffer {
  const parts: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const body = typeof content === 'string' ? Buffer.from(content) : Buffer.from(content);
    parts.push(header(name, body.length, '0'), body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}
