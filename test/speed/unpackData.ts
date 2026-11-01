// Unpacks a data package (a .vsix built by the bundle workflow, for example a
// livemd2tex-core-data-<date>.vsix) into a folder outside the repository, so the benchmark can run on that image
// (bench.js --data DIR/data). The package itself is only read. Measurement only (docs/DEVELOPING.md).
//
//   node out/test/speed/unpackData.js PACKAGE.vsix OUT_DIR

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { importScript } from '../support/helpers';

async function main() {
  const [pkg, out] = process.argv.slice(2);
  const { readZip } = await importScript<{ readZip(b: Buffer): Map<string, Buffer> }>('scripts/lib/zip.mjs');
  const { isOutside } = await importScript<{ isOutside(root: string, p: string): boolean }>('scripts/lib/paths.mjs');
  mkdirSync(out, { recursive: true });
  const t0 = performance.now();
  const entries = readZip(readFileSync(pkg));
  const t1 = performance.now();
  let n = 0;
  for (const [name, data] of entries) {
    if (!name.startsWith('extension/data/')) {
      continue;
    }
    const target = path.join(out, ...name.slice('extension/'.length).split('/'));
    // An entry name may not reach outside the output folder ("..", an absolute path).
    if (isOutside(out, target) || name.split('/').includes('..')) {
      throw new Error(`refused an entry outside the output folder: ${name}`);
    }
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, data);
    n++;
  }
  console.log(`${n} files under ${path.join(out, 'data')}; read and inflated in ${Math.round(t1 - t0)} ms`);
}

main().then(() => process.exit(0), (e: unknown) => { console.error(e); process.exit(1); });
