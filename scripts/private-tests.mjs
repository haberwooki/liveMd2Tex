#!/usr/bin/env node
// Compiles the private test overlay (docs/DESIGN.md#testing; scripts/lib/private-tests.cjs) into the git-ignored
// out/private/. npm run test:unit, npm run test:engine and scripts/run-integration.mjs run it after tsc. It
// always empties out/private/ first. Without "privateTests" in .private-fixtures.json it does nothing else and
// says nothing; when the named folder is absent it says so in one line and goes on.
//
// The overlay is type-checked with the repository's tsconfig.json. An import in an overlay file is resolved as if
// the file lay in a folder one level below the repository root (a relative import inside the overlay is tried in
// the overlay first), so ../../src/shared/identity and a package such as pdf-lib resolve in the repository. Only
// the overlay files are emitted, into out/private/ at the same depth; the repository's own files are compiled by
// tsc into out/ as usual, where the emitted imports find them.

import { createRequire } from 'node:module';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isOutside } from './lib/paths.mjs';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const { privateTestsFolder } = require('./lib/private-tests.cjs');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every TypeScript file under `dir`, skipping node_modules and dot folders. */
function tsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...tsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Type-checks the overlay `overlay` against the repository at `root` and writes its JavaScript into `outDir`
 * (the folder layout of the overlay is kept). Returns the emitted file count; throws with tsc's messages on an
 * error.
 */
export function compilePrivateTests({ root = repoRoot, overlay, outDir = path.join(root, 'out', 'private') }) {
  if (!isOutside(root, overlay)) {
    throw new Error('The private test folder must lie outside the repository.');
  }
  const config = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);
  if (config.error) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const options = {
    ...parsed.options,
    rootDir: overlay,
    outDir,
    typeRoots: [path.join(root, 'node_modules', '@types')],
    sourceMap: false,
    declaration: false,
    noEmit: false,
  };
  const inOverlay = (file) => {
    const rel = path.relative(overlay, file);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  };
  const virtual = (file) => path.join(root, path.basename(overlay), path.relative(overlay, file));
  const host = ts.createCompilerHost(options);
  host.resolveModuleNameLiterals = (literals, containingFile, redirected, opts, containingSourceFile) =>
    literals.map((literal) => {
      const mode = ts.getModeForUsageLocation(containingSourceFile, literal, opts);
      const resolve = (from) => ts.resolveModuleName(literal.text, from, opts, host, undefined, redirected, mode);
      if (!inOverlay(containingFile)) {
        return resolve(containingFile);
      }
      const own = literal.text.startsWith('.') ? resolve(containingFile) : undefined;
      return own?.resolvedModule ? own : resolve(virtual(containingFile));
    });
  const files = tsFiles(overlay);
  const ambient = parsed.fileNames.filter((f) => f.endsWith('.d.ts'));
  const program = ts.createProgram([...ambient, ...files], options, host);
  const fail = (problems) => {
    const format = { getCanonicalFileName: (f) => f, getCurrentDirectory: () => root, getNewLine: () => '\n' };
    throw new Error(ts.formatDiagnostics(problems, format));
  };
  // 6059: a repository file lies outside rootDir. Only the overlay is emitted, so that does not matter.
  const problems = ts.getPreEmitDiagnostics(program).filter((d) => d.code !== 6059);
  if (problems.length > 0) {
    fail(problems);
  }
  const own = new Set(files.map((f) => path.resolve(f).toLowerCase()));
  let emitted = 0;
  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile || !own.has(path.resolve(source.fileName).toLowerCase())) {
      continue;
    }
    const result = program.emit(source);
    problems.push(...result.diagnostics.filter((d) => d.code !== 6059));
    emitted++;
  }
  if (problems.length > 0) {
    fail(problems);
  }
  return emitted;
}

function main() {
  const outDir = path.join(repoRoot, 'out', 'private');
  rmSync(outDir, { recursive: true, force: true });
  const overlay = privateTestsFolder(repoRoot);
  if (!overlay) {
    return 0;
  }
  if (!existsSync(overlay)) {
    console.log('Private tests: the folder that .private-fixtures.json names is absent; they are skipped.');
    return 0;
  }
  try {
    const count = compilePrivateTests({ overlay, outDir });
    console.log(`Private tests: ${count} file(s) compiled into out/private/.`);
    return 0;
  } catch (err) {
    // Nothing half-compiled is left for a runner to pick up.
    rmSync(outDir, { recursive: true, force: true });
    console.error(`Private tests: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(main());
}
