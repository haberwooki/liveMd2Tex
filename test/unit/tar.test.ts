// The tar reader of the bundle builder (scripts/lib/tar.mjs; B1). The test writes its own small archives: plain
// ustar entries, a long ustar name with a prefix, GNU long names, pax paths with UTF-8, links and folders, and
// damaged or hostile archives that must fail.

import * as assert from 'node:assert/strict';
import { importScript } from '../support/helpers';

interface Entry {
  path: string;
  type: 'file' | 'dir' | 'symlink' | 'hardlink';
  data?: Uint8Array;
  link?: string;
  mode: number;
}
interface Tar {
  readTar(tar: Uint8Array): Entry[];
  safePath(p: string): string | null;
}

/** One header block. */
function header(name: string, size: number, type: string, opts: { link?: string; prefix?: string; base256?: boolean } = {}): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  if (opts.base256) {
    h[124] = 0x80;
    h.writeUIntBE(size, 12 - 6 + 124, 6);
  } else {
    h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  }
  h.write('00000000000\0', 136);
  h.write(type, 156);
  if (opts.link) {
    h.write(opts.link, 157, 100, 'utf8');
  }
  h.write('ustar\0', 257);
  h.write('00', 263);
  if (opts.prefix) {
    h.write(opts.prefix, 345, 155, 'utf8');
  }
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of h) {
    sum += b;
  }
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}

const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
const file = (name: string, data: string | Buffer, opts?: { prefix?: string; base256?: boolean }) => {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return Buffer.concat([header(name, body.length, '0', opts), pad(body)]);
};
const paxRecord = (key: string, value: string) => {
  const rest = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(rest) + 1;
  while (Buffer.byteLength(`${len}${rest}`) !== len) {
    len++;
  }
  return `${len}${rest}`;
};
const end = Buffer.alloc(1024);

describe('tar reader (scripts/lib/tar.mjs; B1)', () => {
  let tar: Tar;
  before(async () => {
    tar = await importScript<Tar>('scripts/lib/tar.mjs');
  });

  it('reads files, folders, links, long names and pax paths', () => {
    const longName = `texmf-dist/tex/latex/${'a'.repeat(120)}/file.sty`;
    const paxBody = Buffer.from(paxRecord('path', 'texmf-dist/doc/Größe/readme.txt'));
    const archive = Buffer.concat([
      header('texmf-dist/', 0, '5'),
      file('texmf-dist/tex/latex/foo/foo.sty', '\\ProvidesPackage{foo}\n'),
      file('foo.cls', 'class', { prefix: 'texmf-dist/tex/latex/foo' }),
      header('././@LongLink', Buffer.byteLength(longName) + 1, 'L'),
      pad(Buffer.from(`${longName}\0`)),
      file('ignored-short-name', 'long'),
      header('PaxHeader', paxBody.length, 'x'),
      pad(paxBody),
      file('ignored-too', 'umlaut'),
      header('texmf-dist/tex/latex/foo/link.sty', 0, '2', { link: 'foo.sty' }),
      header('texmf-dist/tex/latex/foo/hard.sty', 0, '1', { link: 'texmf-dist/tex/latex/foo/foo.sty' }),
      file('big.bin', Buffer.alloc(700, 7), { base256: true }),
      end,
    ]);
    const entries = tar.readTar(archive);
    assert.deepEqual(
      entries.map((e) => [e.path, e.type]),
      [
        ['texmf-dist', 'dir'],
        ['texmf-dist/tex/latex/foo/foo.sty', 'file'],
        ['texmf-dist/tex/latex/foo/foo.cls', 'file'],
        [longName, 'file'],
        ['texmf-dist/doc/Größe/readme.txt', 'file'],
        ['texmf-dist/tex/latex/foo/link.sty', 'symlink'],
        ['texmf-dist/tex/latex/foo/hard.sty', 'hardlink'],
        ['big.bin', 'file'],
      ],
    );
    assert.equal(Buffer.from(entries[1].data as Uint8Array).toString(), '\\ProvidesPackage{foo}\n');
    assert.equal(entries[5].link, 'foo.sty');
    assert.equal((entries[7].data as Uint8Array).length, 700);
  });

  it('refuses a damaged header, a path that leaves the archive, and an archive cut short', () => {
    const good = Buffer.concat([file('a.txt', 'x'), end]);
    const bad = Buffer.from(good);
    bad[0] = 0x62;
    assert.throws(() => tar.readTar(bad), /damaged header/);
    assert.throws(() => tar.readTar(Buffer.concat([file('../escape.txt', 'x'), end])), /outside the archive/);
    assert.throws(() => tar.readTar(Buffer.concat([file('/abs.txt', 'x'), end])), /outside the archive/);
    assert.throws(() => tar.readTar(file('a.txt', 'y'.repeat(600)).subarray(0, 700)), /ends inside a file/);
    assert.equal(tar.safePath('a/./b/../c'), 'a/c');
    assert.equal(tar.safePath('a/../../c'), null);
  });
});
