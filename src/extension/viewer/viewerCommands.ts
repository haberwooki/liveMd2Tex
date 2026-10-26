// The viewer's commands (docs/DESIGN.md#accessibility, M2-B): every toolbar button is also a VS Code command, so the
// keyboard reaches all of them (keybindings while the preview has focus, and the Command Palette): next and
// previous page, zoom in and out, fit the width, the High Contrast page colours, and focus the preview. Jump to
// source is the sync service's command (Shift+Alt+J in the preview). F6 moves between VS Code's parts as usual.

import * as vscode from 'vscode';
import { COMMAND_PREFIX } from '../../shared/identity';
import type { ViewerCommand, ViewerState } from '../../shared/viewerProtocol';
import type { PreviewPanel } from './previewPanel';

export const VIEWER_COMMANDS: ViewerCommand[] = ['nextPage', 'previousPage', 'zoomIn', 'zoomOut', 'fitWidth', 'toggleThemeColours', 'focus'];

/** Registers `${prefix}.viewer.<name>` for each command; `preview` picks the panel they act on. */
export function registerViewerCommands(preview: () => PreviewPanel | undefined): vscode.Disposable[] {
  const run = async (name: ViewerCommand): Promise<ViewerState | undefined> => {
    const panel = preview();
    if (!panel || panel.isDisposed) {
      void vscode.window.showInformationMessage('No PDF preview is open.');
      return undefined;
    }
    if (name === 'focus' || !panel.panel.visible) {
      panel.panel.reveal(undefined, name !== 'focus');
    }
    return panel.command(name);
  };
  return VIEWER_COMMANDS.map((name) => vscode.commands.registerCommand(`${COMMAND_PREFIX}.viewer.${name}`, () => run(name)));
}
