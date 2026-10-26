// The LaTeX Workshop offer in VS Code (latexWorkshop.ts holds the rules): shown once per workspace when a .tex
// file is first opened or saved and LaTeX Workshop builds automatically.

import * as vscode from 'vscode';
import { COMMAND_PREFIX } from '../../shared/identity';
import { AUTO_BUILD_KEY, AUTO_BUILD_SECTION, LATEX_WORKSHOP_ID, offerAutoBuildOff, type OfferOutcome } from './latexWorkshop';

/** Tests only: the answer the question gets instead of a notification (null: ask the user). */
let answerForTests: string | undefined | null = null;
export function setOfferAnswerForTests(answer: string | undefined | null): void {
  answerForTests = answer;
}

export function offerLatexWorkshopSetup(context: vscode.ExtensionContext, log?: (line: string) => void): Promise<OfferOutcome> {
  const key = `${COMMAND_PREFIX}.latexWorkshopOffered`;
  const settings = () => vscode.workspace.getConfiguration(AUTO_BUILD_SECTION);
  return offerAutoBuildOff({
    installed: () => vscode.extensions.getExtension(LATEX_WORKSHOP_ID) !== undefined,
    hasWorkspace: () => (vscode.workspace.workspaceFolders?.length ?? 0) > 0,
    offered: () => context.workspaceState.get<boolean>(key) === true,
    markOffered: async () => {
      await context.workspaceState.update(key, true);
    },
    autoBuild: () => settings().get<string>(AUTO_BUILD_KEY),
    ask: (message, yes, no) => (answerForTests !== null ? Promise.resolve(answerForTests) : Promise.resolve(vscode.window.showInformationMessage(message, yes, no))),
    turnOffAutoBuildInWorkspace: async () => {
      await settings().update(AUTO_BUILD_KEY, 'never', vscode.ConfigurationTarget.Workspace);
    },
    log,
  });
}
