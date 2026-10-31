#!/usr/bin/env node
// engine/build/tools/glue-imports.mjs: resolves the engine's WebAssembly imports and exports through its
// JavaScript glue, for the import check and the manifest (wasm-inspect.mjs, write-manifest.mjs).
//
// Ours (the liveMd2Tex authors), GPL-3.0-or-later.
//
// At -Oz with ASSERTIONS=0, Emscripten minifies the wasm's import and export names (tools/link.py:1606-1621 at
// 6.0.13). The glue keeps the map: "var wasmImports = {a: ___syscall_openat, ...}" (tools/emscripten.py,
// create_sending: each key is the wasm import's name, each value the JavaScript function it calls), and
// "function assignWasmExports(wasmExports) { _main = Module['_main'] = wasmExports['b']; ... }"
// (create_receiving). acorn parses the glue; this file reads those two places and nothing else.
//
//   node glue-imports.mjs OUT          prints the resolved imports and exports of OUT/engine.wasm and OUT/engine.js

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readWasm } from './wasm-inspect.mjs';

let acorn = null;

/** acorn: the repository's copy (package.json devDependencies), else the one inside the emsdk (EMSDK). */
export async function loadAcorn() {
  if (acorn) return acorn;
  try {
    acorn = await import('acorn');
  } catch {
    const emsdk = process.env.EMSDK;
    if (!emsdk) throw new Error('acorn not found: install the repository dependencies or set EMSDK');
    acorn = await import(pathToFileURL(path.join(emsdk, 'upstream/emscripten/node_modules/acorn/dist/acorn.mjs')).href);
  }
  return acorn;
}

/** The loaded acorn module (after loadAcorn()). */
export function glueAcorn() {
  if (!acorn) throw new Error('call loadAcorn() first');
  return acorn;
}

function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end') continue;
    const v = node[key];
    if (Array.isArray(v)) for (const x of v) walk(x, visit);
    else if (v && typeof v.type === 'string') walk(v, visit);
  }
}

function keyName(prop) {
  if (prop.key.type === 'Identifier') return prop.key.name;
  if (prop.key.type === 'Literal') return String(prop.key.value);
  return null;
}

function targetName(node) {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression' && node.object.type === 'Identifier' && node.object.name === 'Module') {
    if (node.computed && node.property.type === 'Literal') return `Module['${node.property.value}']`;
    if (!node.computed && node.property.type === 'Identifier') return `Module['${node.property.name}']`;
  }
  return null;
}

function wasmExportKey(node) {
  if (node.type === 'MemberExpression' && node.object.type === 'Identifier' && node.object.name === 'wasmExports') {
    if (node.computed && node.property.type === 'Literal') return String(node.property.value);
    if (!node.computed && node.property.type === 'Identifier') return node.property.name;
  }
  return null;
}

/** The glue's two maps: import key -> JavaScript function name, and wasm export key -> JavaScript names. */
export function parseGlue(glueText) {
  if (!acorn) throw new Error('call loadAcorn() first');
  const ast = acorn.parse(glueText, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true, locations: true });
  const imports = new Map();
  // An import whose value is a function written in place has no name: its text is kept instead. A glue linked
  // without -g1 writes every library function into wasmImports this way (43 of the engine's 46 imports), which is why the engine ships the -g1 glue and the build refuses --no-g1.
  const inlined = new Map();
  let importsLine = null;
  const exports = new Map();
  const ctors = [];
  walk(ast, (node) => {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.id.name === 'wasmImports' && node.init?.type === 'ObjectExpression') {
      importsLine = node.loc.start.line;
      for (const prop of node.init.properties) {
        if (prop.type !== 'Property') continue;
        const k = keyName(prop);
        const v = prop.value.type === 'Identifier' ? prop.value.name : null;
        if (k !== null) imports.set(k, v);
        if (k !== null && v === null) inlined.set(k, glueText.slice(prop.value.start, prop.value.end));
      }
    }
    if (node.type === 'FunctionDeclaration' && node.id?.name === 'assignWasmExports') {
      walk(node.body, (inner) => {
        if (inner.type !== 'ExpressionStatement' || inner.expression.type !== 'AssignmentExpression') return;
        const names = [];
        let e = inner.expression;
        while (e.type === 'AssignmentExpression') {
          const t = targetName(e.left);
          if (t) names.push(t);
          e = e.right;
        }
        const key = wasmExportKey(e);
        if (key !== null) exports.set(key, names);
      });
    }
    // The static constructors: initRuntime calls the export by its key and assigns it to no name
    // (src/preamble.js, initRuntime: wasmExports['__wasm_call_ctors']() before minification).
    if (node.type === 'FunctionDeclaration' && node.id?.name === 'initRuntime') {
      walk(node.body, (inner) => {
        if (inner.type !== 'CallExpression' || inner.arguments.length !== 0) return;
        const key = wasmExportKey(inner.callee);
        if (key !== null && !ctors.includes(key)) ctors.push(key);
      });
    }
  });
  for (const key of ctors) if (!exports.has(key)) exports.set(key, ['__wasm_call_ctors']);
  return { imports, inlined, exports, importsLine };
}

/** Resolves a wasm's imports and exports through its glue. */
export function resolveGlue(glueText, w) {
  const g = parseGlue(glueText);
  return {
    importsLine: g.importsLine,
    imports: w.imports.map((i) => ({
      module: i.module,
      name: i.name,
      kind: i.kind,
      resolved: i.kind === 'func' ? (g.imports.has(i.name) ? g.imports.get(i.name) : null) : g.imports.get(i.name) ?? `(${i.kind})`,
      ...(g.inlined.has(i.name) ? { inlined: g.inlined.get(i.name) } : {}),
    })),
    exports: w.exports.map((e) => ({
      key: e.name,
      kind: e.kind,
      names: g.exports.get(e.name) ?? [],
      name: (g.exports.get(e.name) ?? []).find((n) => !n.startsWith('Module[')) ?? (g.exports.get(e.name) ?? [])[0] ?? `(${e.kind} ${e.name})`,
    })),
  };
}

async function main(argv) {
  const out = argv[0];
  if (!out) {
    console.error('usage: glue-imports.mjs OUT (a folder with engine.wasm and engine.js)');
    return 2;
  }
  await loadAcorn();
  const w = readWasm(readFileSync(path.join(out, 'engine.wasm')));
  const r = resolveGlue(readFileSync(path.join(out, 'engine.js'), 'utf8'), w);
  console.log(JSON.stringify(r, null, 1));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
