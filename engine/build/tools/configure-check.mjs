#!/usr/bin/env node
// engine/build/tools/configure-check.mjs: the build machine's own programs must not change what configure writes.
// Two machines with the same pins must give the same generated sources (engine-build.json, generatedSources), and a
// program one machine has and the other lacks would change them: a GitHub runner has flex and bison, and configure
// wrote "#define YYTEXT_POINTER 1" into two c-auto.h files there, against "#undef" under WSL, which has neither.
// build.sh therefore passes LEX=: and YACC=: to every configure run (TeX Live ships the scanners and parsers flex
// and bison would make), and runs this check on each tree it configured. It fails when
//   - a configure run took a lex or a yacc other than ":" (LEX or YACC in a config.log's output variables);
//   - a c-auto.h or config.h defines YYTEXT_POINTER (what a found flex writes);
//   - a library came from the build machine: a configure run was given --with-system-LIB (TeX Live's top level
//     gives each folder its choice; it takes its own copy of a library whose folder is in the tree), or pkg-config
//     found a library for one (a pkg_cv_ answer). Every library must be TeX Live's own, or given by its folders
//     (fontconfig's stand-in): TeX Live's scripts ask pkg-config about the machine's libraries, and use the answer
//     only for a library taken from the system, so the machine's packages (WSL has libfreetype-dev, libpng-dev and
//     zlib1g-dev for the font check) must decide nothing;
//   - with --logs: a step log shows make running a generator, build-aux/missing (aclocal, automake, autoconf,
//     autoheader, makeinfo) or build-aux/ylwrap (flex, bison), or help2man: the files they make are TeX Live's
//     own, kept by build.sh's unpack step, and a machine that has the program would remake them.
//
// Ours (the liveMd2Tex authors), GPL-3.0-or-later.
//
//   node configure-check.mjs TREE [--logs DIR]

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** A make rule that runs a generator, in a step log. */
const GENERATOR = /build-aux\/(missing|ylwrap)\s|\bhelp2man\s/;

/**
 * The problems in a configured tree's files, each given as { path, text }: config.log, c-auto.h and config.h files
 * (by base name), and step logs (any other name, with logs true).
 */
export function configureProblems(files) {
  const out = [];
  for (const { path: p, text, log } of files) {
    const base = p.split('/').pop();
    if (log) {
      text.split('\n').forEach((line, i) => {
        if (GENERATOR.test(line)) out.push(`${p}:${i + 1}: make ran a generator: ${line.trim().slice(0, 160)}`);
      });
    } else if (base === 'config.log') {
      for (const m of text.matchAll(/^(LEX|YACC)='(.*)'$/gm)) {
        if (m[2] !== ':') out.push(`${p}: ${m[1]}='${m[2]}', not ':': configure looked for the build machine's ${m[1] === 'LEX' ? 'lex' : 'yacc'}`);
      }
      const pkg = text.match(/^pkg_cv_\w+=/m);
      if (pkg) out.push(`${p}: pkg-config found a library of the build machine (${pkg[0].slice(0, -1)})`);
      const system = text.match(/'--with-system-[A-Za-z0-9_+-]+(=yes)?'/);
      if (system) out.push(`${p}: a library of the build machine was used (${system[0]})`);
    } else if (/^#define\s+YYTEXT_POINTER\b/m.test(text)) {
      out.push(`${p}: defines YYTEXT_POINTER (configure found a flex)`);
    }
  }
  return out;
}

/** config.log, c-auto.h and config.h under a tree, as { path, text } with tree-relative paths. */
function treeFiles(tree) {
  const out = [];
  const walk = (rel) => {
    for (const e of readdirSync(path.join(tree, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else if (e.isFile() && ['config.log', 'c-auto.h', 'config.h'].includes(e.name)) out.push({ path: r, text: readFileSync(path.join(tree, r), 'latin1') });
    }
  };
  walk('');
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const tree = args[0];
  const logsAt = args.indexOf('--logs');
  if (!tree || tree.startsWith('--')) {
    console.error('usage: node configure-check.mjs TREE [--logs DIR]');
    process.exit(2);
  }
  const files = treeFiles(tree);
  if (logsAt >= 0) {
    const dir = args[logsAt + 1];
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.log')).sort()) files.push({ path: `logs/${name}`, text: readFileSync(path.join(dir, name), 'latin1'), log: true });
  }
  const logs = files.filter((f) => f.path.endsWith('config.log')).length;
  if (logs === 0) {
    console.error(`configure-check: no config.log under ${path.basename(tree)}`);
    process.exit(1);
  }
  const problems = configureProblems(files);
  for (const p of problems) console.error(`configure-check: ${p}`);
  console.log(`configure-check: ${path.basename(tree)}: ${logs} config.log files, ${files.length - logs} headers and logs; ${problems.length ? `${problems.length} problem(s)` : 'no lex, yacc, library or generator from the build machine'}`);
  process.exit(problems.length ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
