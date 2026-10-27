// The engine M5's coverage run gives a document on the extension's side (docs/coverage-method.md, "The engine" and
// "A document in flight counts"). Kept apart from coverageRun.ts, which runs on import, so the unit tests can call it.

import { chooseEngine, type EngineChoice } from '../../src/extension/project/texText';

/**
 * The engine setting the measurement gives the extension for a document: XeLaTeX when the document asks for
 * XeLaTeX or LuaLaTeX (by a % !TEX line or by its documentation tree), as a user who asks for either would set it;
 * otherwise the default setting, pdfLaTeX. This is the measurement's choice; the extension's own rule then reads the
 * document (chooseEngine).
 */
export function measurementSetting(requested: string | null | undefined): 'pdflatex' | 'xelatex' {
  return requested === 'xelatex' || requested === 'lualatex' ? 'xelatex' : 'pdflatex';
}

/**
 * The engine the extension will run for a document, by its own rule on the main file's text and the measurement's
 * setting: what the in-flight mark records before the compile starts, so that a document on which the measuring
 * process dies is compiled on TeX Live with the engine the extension chose, and counts as the extension's failure.
 */
export function extensionEngine(mainText: string, requested: string | null | undefined): EngineChoice['engine'] {
  return chooseEngine(mainText, measurementSetting(requested)).engine;
}
