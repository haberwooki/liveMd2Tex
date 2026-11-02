// Reads the .cpuprofile files that `--host-arg --cpu-prof --host-arg --cpu-prof-dir=DIR` makes (one per thread of
// the engine host: its main thread and each compile worker) and sums self time by kind: the engine's WebAssembly,
// the Emscripten glue (file system, LZ4), our worker code, garbage collection, idle. The pinned engine.wasm has no
// name section, so WebAssembly functions show by index only; a build linked with --profiling-funcs names them.
//
//   node out/test/speed/profile.js DIR [--top N]

import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { option } from './common';

interface Node {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
  hitCount?: number;
  children?: number[];
}
interface Profile {
  nodes: Node[];
  startTime: number;
  endTime: number;
  samples: number[];
  timeDeltas: number[];
}

function kind(n: Node): string {
  const { functionName: f, url } = n.callFrame;
  if (url.startsWith('wasm://') || /^\$|wasm-function/.test(f)) {
    return 'wasm (engine)';
  }
  if (f === '(garbage collector)') {
    return 'GC';
  }
  if (f === '(idle)') {
    return 'idle';
  }
  if (f === '(program)' || f === '(root)') {
    return 'V8 (program)';
  }
  const base = path.basename(url);
  if (/busytex|engine\.js|patched/.test(base)) {
    return 'glue JS (FS, LZ4)';
  }
  if (/engine-worker|engine-host/.test(base)) {
    return 'our JS (worker, host)';
  }
  if (!url) {
    return 'native/builtin';
  }
  return `other JS (${base})`;
}

function main(): void {
  const dir = process.argv[2];
  if (!dir || dir.startsWith('--')) {
    console.error('give the folder of .cpuprofile files first');
    process.exit(2);
  }
  const top = option(process.argv.slice(3), '--top', 25, true);
  if (!Number.isInteger(top) || top < 1) {
    console.error(`--top needs a whole number of at least 1, not ${top}`);
    process.exit(2);
  }
  const byKind = new Map<string, number>();
  const byFn = new Map<string, number>();
  let total = 0;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.cpuprofile'))) {
    const p = JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as Profile;
    const nodes = new Map(p.nodes.map((n) => [n.id, n]));
    for (let i = 0; i < p.samples.length; i++) {
      const n = nodes.get(p.samples[i]);
      const dt = (p.timeDeltas[i + 1] ?? 0) / 1000;
      if (!n) {
        continue;
      }
      const k = kind(n);
      byKind.set(k, (byKind.get(k) ?? 0) + dt);
      if (k !== 'idle') {
        total += dt;
        const name = `${n.callFrame.functionName || '(anonymous)'} ${path.basename(n.callFrame.url)}${n.callFrame.url ? `:${n.callFrame.lineNumber + 1}` : ''}`;
        byFn.set(name, (byFn.get(name) ?? 0) + dt);
      }
    }
  }
  console.log(`busy time sampled: ${Math.round(total)} ms (idle ${Math.round(byKind.get('idle') ?? 0)} ms)`);
  for (const [k, v] of [...byKind].filter(([k]) => k !== 'idle').sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(28)} ${String(Math.round(v)).padStart(7)} ms  ${((100 * v) / total).toFixed(1).padStart(5)} %`);
  }
  console.log(`top ${top} functions by self time:`);
  for (const [f, v] of [...byFn].sort((a, b) => b[1] - a[1]).slice(0, top)) {
    console.log(`  ${String(Math.round(v)).padStart(7)} ms  ${((100 * v) / total).toFixed(1).padStart(5)} %  ${f}`);
  }
}

main();
