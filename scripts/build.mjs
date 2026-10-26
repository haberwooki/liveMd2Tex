#!/usr/bin/env node
// Builds dist/ with esbuild (the esbuild-wasm package: same esbuild, run as WebAssembly, no native program).
//
//   dist/extension.js     Node bundle for the extension host (CommonJS; "vscode" external)
//   dist/fork.js          the one fork file, kept as its own bundle so the VSIX scan can pin child_process to it
//   dist/engine-host.js   Node bundle for the engine-host child process
//   dist/engine-worker.js Node bundle for the engine host's compile worker (one worker_thread per compile)
//   dist/synctex-worker.js Node bundle for the SyncTeX worker (a worker_thread of the extension host)
//   dist/viewer/          the webview page script, its CSS and the pdf.js runtime files, copied verbatim
//   dist/web/extension.js browser bundle (built on the laptop, run only on CI from G0)
//   dist/licenses/        the licence text of every npm package bundled into a shipped file (found through
//                         esbuild's metafile), with an index, and the GPL-3, AGPL-3, LGPL-3, Apache-2.0, LPPL and
//                         CC0 texts from LICENSES/ (build gate 1, G1S-04)
//
// Usage: node scripts/build.mjs [--production]

import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild-wasm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const production = process.argv.includes('--production');
const pdfjsRoot = path.join(root, 'node_modules', 'pdfjs-dist');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// dist/extension.js loads the fork module from ./fork.js at run time instead of bundling it.
const forkModuleExternal = {
  name: 'fork-module-external',
  setup(build) {
    build.onResolve({ filter: /^\.\/engineHostFork$/ }, () => ({ path: './fork.js', external: true }));
  },
};

const common = {
  bundle: true,
  minify: false,
  sourcemap: production ? false : 'linked',
  sourcesContent: false,
  legalComments: 'inline',
  logLevel: 'warning',
  absWorkingDir: root,
};

const nodeTarget = 'node22'; // VS Code 1.105 runs Node 22 (EVIDENCE [389]); later versions run Node 24.

// One build at a time: esbuild-wasm 0.28.2 on Windows rejects the working directory of every build that
// starts while another is running ("is not an absolute path"); run one after another, all succeed.
const builds = [
  {
    ...common,
    entryPoints: ['src/extension/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: nodeTarget,
    external: ['vscode'],
    plugins: [forkModuleExternal],
    // isomorphic-git's ES-module entry, so esbuild drops the commands the Git reader does not import. Its
    // CommonJS entry (picked by the "node" condition) keeps every command, including fetch, clone, push and
    // the HTTP remote helpers, and the VSIX scan would then find network names in the bundle (C0a).
    alias: {
      'isomorphic-git': path.join(root, 'node_modules', 'isomorphic-git', 'index.js'),
      // Node always has Function.prototype.bind; function-bind's fallback builds code from text (G1S-07).
      'function-bind': path.join(root, 'scripts', 'shims', 'function-bind.cjs'),
    },
  },
  {
    ...common,
    entryPoints: ['src/extension/engineHostFork.ts'],
    outfile: 'dist/fork.js',
    platform: 'node',
    format: 'cjs',
    target: nodeTarget,
  },
  {
    ...common,
    entryPoints: ['src/engine-host/main.ts'],
    outfile: 'dist/engine-host.js',
    platform: 'node',
    format: 'cjs',
    target: nodeTarget,
  },
  {
    ...common,
    entryPoints: ['src/engine-host/engine/worker.ts'],
    outfile: 'dist/engine-worker.js',
    platform: 'node',
    format: 'cjs',
    target: nodeTarget,
  },
  {
    ...common,
    entryPoints: ['src/synctex/worker.ts'],
    outfile: 'dist/synctex-worker.js',
    platform: 'node',
    format: 'cjs',
    target: nodeTarget,
  },
  {
    ...common,
    entryPoints: ['src/webview/viewer.ts'],
    outfile: 'dist/viewer/viewer.js',
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
  },
  {
    ...common,
    entryPoints: ['src/web/extension.ts'],
    outfile: 'dist/web/extension.js',
    platform: 'browser',
    format: 'cjs',
    target: 'es2022',
    external: ['vscode'],
  },
];
// The files that ship in the VSIX (.vscodeignore); the web bundle does not ship yet.
const shipped = new Set(['dist/extension.js', 'dist/fork.js', 'dist/engine-host.js', 'dist/engine-worker.js', 'dist/synctex-worker.js', 'dist/viewer/viewer.js']);
const bundledPackages = new Map();
for (const options of builds) {
  const result = await esbuild.build({ ...options, metafile: true });
  if (!shipped.has(options.outfile)) {
    continue;
  }
  for (const input of Object.keys(result.metafile.inputs)) {
    const p = input.replace(/\\/g, '/');
    const at = p.lastIndexOf('node_modules/');
    if (at >= 0) {
      const rest = p.slice(at + 'node_modules/'.length).split('/');
      const name = rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
      bundledPackages.set(name, path.join(root, p.slice(0, at), 'node_modules', ...name.split('/')));
    }
  }
}
await esbuild.stop?.();

const MIT_TEXT = `MIT License

Copyright (c) <copyright holders>

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of
the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
IN THE SOFTWARE.
`;

// Licence texts (build gate 1, G1S-04): every bundled package's own licence file, and the long texts.
const licences = path.join(dist, 'licenses');
mkdirSync(licences, { recursive: true });
const index = ['Licences of the parts of liveMd2Tex that are not its own (see THIRD_PARTY_NOTICES.md).', ''];
const missingLicence = [];
for (const [name, dir] of [...bundledPackages].sort((a, b) => a[0].localeCompare(b[0]))) {
  const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)([-.][\w.-]*)?$/i.test(f));
  const out = `${name.replace('/', '__')}.txt`;
  const author = typeof pkg.author === 'string' ? pkg.author : (pkg.author?.name ?? 'its authors');
  if (file) {
    cpSync(path.join(dir, file), path.join(licences, out));
  } else if (pkg.license === 'MIT') {
    // No licence file in the package: the MIT text with the author named in its package.json.
    writeFileSync(path.join(licences, out), `${name} ${pkg.version}\n\n${MIT_TEXT.replace('<copyright holders>', author)}`);
  } else if (pkg.license === 'Apache-2.0') {
    writeFileSync(path.join(licences, out), `${name} ${pkg.version}, by ${author}, under the Apache License 2.0: see Apache-2.0.txt.\n`);
  } else {
    missingLicence.push(name);
    writeFileSync(path.join(licences, out), `${name} ${pkg.version}: licence "${pkg.license}" (the package has no licence file).\n`);
  }
  index.push(`${name} ${pkg.version}: ${typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license)} -> ${out}`);
}
cpSync(path.join(root, 'LICENSE'), path.join(licences, 'GPL-3.0.txt'));
for (const text of readdirSync(path.join(root, 'LICENSES')).filter((f) => f.endsWith('.txt'))) {
  cpSync(path.join(root, 'LICENSES', text), path.join(licences, text));
}
index.push(
  '',
  'GPL-3.0.txt, AGPL-3.0.txt, LGPL-3.0.txt, Apache-2.0.txt, LPPL-1.3c.txt: the full licence texts.',
  "ICU.txt: ICU's licence (the Unicode License V3 and its third-party notices), for the ICU built into the engine and its data.",
  "MakeIndex.txt: MakeIndex's notice, for the MakeIndex built into the engine; THIRD_PARTY_NOTICES.md says where its source is.",
  'CC0-1.0.txt: CC0 1.0 Universal, under which the liveMd2Tex authors dedicate the starting documents (templates/)',
  'and the example presets (examples/presets/) to the public domain, because they are copied into your own folders.',
);
writeFileSync(path.join(licences, 'INDEX.txt'), `${index.join('\n')}\n`);
if (missingLicence.length > 0) {
  console.warn(`no licence file in: ${missingLicence.join(', ')}`);
}

// The viewer's own stylesheet.
cpSync(path.join(root, 'src', 'webview', 'viewer.css'), path.join(dist, 'viewer', 'viewer.css'));

// pdf.js runtime files, copied verbatim so the VSIX scan's allow-list can name their lines. Left out: source
// maps, the minified twins, the legacy build, the scripting sandbox and QuickJS (scripting stays off), and the
// JavaScript fallbacks for the WASM decoders (WASM runs under the viewer's CSP).
const pdfjsOut = path.join(dist, 'viewer', 'pdfjs');
const copies = [
  'LICENSE',
  'build/pdf.mjs',
  'build/pdf.worker.mjs',
  'web/pdf_viewer.mjs',
  'web/pdf_viewer.css',
  'web/images',
  'cmaps',
  'standard_fonts',
  'iccs',
  'wasm/openjpeg.wasm',
  'wasm/qcms_bg.wasm',
  'wasm/jbig2.wasm',
  'wasm/LICENSE_JBIG2',
  'wasm/LICENSE_OPENJPEG',
  'wasm/LICENSE_PDFJS_JBIG2',
  'wasm/LICENSE_PDFJS_OPENJPEG',
  'wasm/LICENSE_PDFJS_QCMS',
  'wasm/LICENSE_QCMS',
];
for (const rel of copies) {
  cpSync(path.join(pdfjsRoot, rel), path.join(pdfjsOut, rel), { recursive: true });
}
const pdfjsVersion = JSON.parse(readFileSync(path.join(pdfjsRoot, 'package.json'), 'utf8')).version;
writeFileSync(path.join(pdfjsOut, 'VERSION'), `pdfjs-dist ${pdfjsVersion}\n`);

const size = (rel) => `${(statSync(path.join(dist, rel)).size / 1024).toFixed(1)} KiB`;
console.log(
  [
    `built dist/ (${production ? 'production' : 'development'}), pdf.js ${pdfjsVersion}`,
    `  extension.js   ${size('extension.js')}`,
    `  fork.js        ${size('fork.js')}`,
    `  engine-host.js ${size('engine-host.js')}`,
    `  engine-worker.js ${size('engine-worker.js')}`,
    `  viewer.js      ${size('viewer/viewer.js')}`,
    `  web bundle     ${size('web/extension.js')}`,
  ].join('\n'),
);
