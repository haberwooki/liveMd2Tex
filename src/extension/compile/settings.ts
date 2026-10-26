// The extension's settings as the compile loop reads them (package.json "contributes.configuration").

import * as vscode from 'vscode';
import { COMMAND_PREFIX } from '../../shared/identity';

export function config<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration(COMMAND_PREFIX).get<T>(key, fallback);
}
