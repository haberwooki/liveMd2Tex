// Lays out the test documents as the workspace of the V0 integration test (scripts/run-integration.mjs calls
// this before VS Code starts): P1 to P8 from the public corpus and, when .private-fixtures.json exists, copies of
// T1 to T5, all under the throwaway profile folder, which run-integration deletes afterwards. P4's class is
// built with the engine's docstrip in an engine host that runs with the engine-host stubs.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { bundledEngineAssets, EngineService } from '../../src/extension/engine/engineService';
import { materializeCorpus, type CorpusProject } from './corpusProjects';
import { root } from './helpers';

export const CORPUS_LIST = 'v0-corpus.json';

/** materializeCorpus's class builder: runs the .ins file through the engine's docstrip and reads the class back. */
export function docstripWith(service: EngineService) {
  return async (folder: string, ins: string, cls: string): Promise<string> => {
    const files = readdirSync(folder).map((f) => ({ path: f, data: new Uint8Array(readFileSync(path.join(folder, f))) }));
    const { result } = await service.compile({
      id: 0,
      main: ins,
      files,
      engine: 'pdflatex',
      bibtex: 'never',
      maxPasses: 1,
      synctex: false,
      steps: [['pdflatex', '-no-shell-escape', '-interaction=nonstopmode', '-fmt', '/texlive/texmf-dist/texmf-var/web2c/pdftex/pdflatex.fmt', ins]],
      readBack: [cls],
    });
    const text = result.readBack?.[cls];
    if (!text) {
      throw new Error(`docstrip did not build ${cls}`);
    }
    return text;
  };
}

/** Writes the projects and `v0-corpus.json` into `target`; returns null without the staged engine. */
export async function prepareV0Workspace(target: string): Promise<CorpusProject[] | null> {
  if (!bundledEngineAssets(root)) {
    return null;
  }
  const service = new EngineService({
    modulePath: path.join(root, 'dist', 'engine-host.js'),
    assets: () => bundledEngineAssets(root),
    idleMinutes: () => 0,
    log: () => undefined,
  });
  service.execArgv = ['--require', path.join(root, 'test', 'stubs', 'register-engine-host.cjs')];
  try {
    const projects = await materializeCorpus(target, docstripWith(service));
    writeFileSync(path.join(target, CORPUS_LIST), JSON.stringify(projects, null, 2));
    return projects;
  } finally {
    await service.stop();
  }
}
