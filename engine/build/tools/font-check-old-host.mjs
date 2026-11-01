// engine/build/tools/font-check-old-host.mjs: side A of the font check (font-check.mjs, check 2):
// the earlier engine (TeXlyre's build, busytex.wasm with its patched glue) under its own host, run from a worktree of
// main at a commit that still pins it, with data packages built for it, with its dist/ and out/ built. Each fixture runs as an explicit
// "xelatex -ini -etex -no-pdf" step, as scripts/lib/bundle-engine.mjs runs -ini steps (-etex: XeTeX's own
// primitives, \XeTeXglyph among them, exist only in extended mode), with the core-data package's image as the host's data
// and the extra-data package's image as a data image (mounted under /texmf-extra), and engine/fonts.conf as that
// host gave it.
//
// Ours (the liveMd2Tex authors), GPL-3.0-or-later.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { chosenFonts } from './xdv.mjs';

const require = createRequire(import.meta.url);

export async function runOldHost(o, batches) {
  const root = path.resolve(o['old-host']);
  const pins = JSON.parse(readFileSync(path.join(root, 'engine', 'pins.json'), 'utf8'));
  const tl = pins.sources.find((s) => s.files?.some((f) => f.name === 'busytex.wasm'));
  const assetsRoot = path.resolve(root, '..', 'engine_assets');
  const dir = path.join(assetsRoot, tl.folder);
  const unpacked = o['old-images'] ?? path.join(o.work, 'images');
  const assets = {
    glue: path.join(assetsRoot, 'derived', tl.patchedGlue.sha256.slice(0, 16), 'busytex.patched.js'),
    wasm: path.join(dir, 'busytex.wasm'),
    data: path.join(unpacked, 'core.data'),
    loader: path.join(unpacked, 'core.index.json'),
    cnfOverride: path.join(root, 'engine', 'texmf-override.cnf'),
    fontsConf: path.join(root, 'engine', 'fonts.conf'),
  };
  const extraData = path.join(unpacked, 'extra.data');
  const extra = {
    id: 'livemd2tex-extra-data',
    version: 'font-check',
    sha256: createHash('sha256').update(readFileSync(extraData)).digest('hex'),
    data: extraData,
    index: path.join(unpacked, 'extra.index.json'),
  };
  const { EngineHost } = require(path.join(root, 'out', 'src', 'extension', 'engineHostClient.js'));
  const host = new EngineHost({ modulePath: path.join(root, 'dist', 'engine-host.js'), requestTimeoutMs: 4 * 3600 * 1000 });
  await host.start();
  await host.init(assets, 600000);
  const chosen = new Map();
  const logs = [];
  const enc = new TextEncoder();
  try {
    for (const [b, batch] of batches.entries()) {
      const name = `b${b}.tex`;
      const result = await host.compile(
        {
          id: b + 1,
          main: name,
          files: [{ path: name, data: enc.encode(batch.text) }],
          engine: 'xelatex',
          bibtex: 'never',
          maxPasses: 1,
          synctex: false,
          steps: [['xelatex', '-ini', '-etex', '-interaction=nonstopmode', '-no-pdf', name]],
          returnNewFiles: true,
          dataImages: [extra],
          knownImages: [`${extra.id}@${extra.version}#${extra.sha256}`],
        },
        4 * 3600 * 1000,
      );
      writeFileSync(path.join(o.work, `side-a-b${b}.transcript.txt`), result.transcript ?? '');
      const xdv = (result.newFiles ?? []).find((f) => f.path === `b${b}.xdv`);
      const pages = xdv ? chosenFonts(Buffer.from(xdv.data)) : new Map();
      batch.reqs.forEach((r, i) => chosen.set(batch.first + i, pages.get(batch.first + i) ?? null));
      logs.push({ batch: b, exit: result.steps?.map((s) => s.exitCode), pages: pages.size, ms: result.steps?.map((s) => s.ms) });
      console.log(`side A batch ${b}: exit ${JSON.stringify(result.steps?.map((s) => s.exitCode))}, ${pages.size} pages of ${batch.reqs.length} requests`);
    }
  } finally {
    await host.stop?.();
  }
  return { chosen, logs };
}
