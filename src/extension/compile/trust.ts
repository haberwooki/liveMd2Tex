// Workspace Trust for the compile loop (docs/DESIGN.md#confinement-and-trust): in Restricted Mode nothing compiles
// by itself, and a compile the user asks for by command asks once whether to go ahead.

import * as vscode from 'vscode';

/** Test only: the answer the Restricted Mode question gets (null: ask). */
let restrictedAnswerForTests: string | undefined | null = null;

export function setRestrictedAnswerForTests(answer: string | undefined | null): void {
  restrictedAnswerForTests = answer;
}

export class Trust {
  private restrictedAnswer: boolean | undefined;
  private restrictedLogged = false;

  constructor(private readonly log: vscode.LogOutputChannel) {}

  /** Whether the compile loop may compile by itself. */
  trusted(): boolean {
    if (vscode.workspace.isTrusted) {
      return true;
    }
    if (!this.restrictedLogged) {
      // docs/DESIGN.md#confinement-and-trust: in Restricted Mode nothing compiles automatically.
      this.log.info('not compiling automatically: the workspace is in Restricted Mode (the compile command still works)');
      this.restrictedLogged = true;
    }
    return false;
  }

  /**
   * Restricted Mode (docs/DESIGN.md#confinement-and-trust): a compile the user asks for by command asks once whether to go ahead.
   * A yes holds for the session; a dismissal asks again at the next command.
   */
  async allowedManually(): Promise<boolean> {
    if (!vscode.workspace.isTrusted && this.restrictedAnswer !== true) {
      const choice =
        restrictedAnswerForTests !== null
          ? restrictedAnswerForTests
          : await vscode.window.showWarningMessage(
              'This workspace is in Restricted Mode. Compile this document anyway? The engine runs inside the extension, with no shell and no network.',
              { modal: true },
              'Compile',
            );
      this.restrictedAnswer = choice === 'Compile';
      this.log.info(`Restricted Mode: the compile command was ${this.restrictedAnswer ? 'allowed for this session' : 'not allowed'}`);
    }
    return vscode.workspace.isTrusted || this.restrictedAnswer === true;
  }
}
