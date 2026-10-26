// Finds the VS Code that is already installed, for tests. Never downloads one (docs/DESIGN.md#rules).
// Order: the VSCODE_TEST_EXECUTABLE environment variable, then the usual install places.

import { existsSync } from 'node:fs';
import path from 'node:path';

export function findInstalledVsCode(env = process.env, platform = process.platform) {
  const candidates = [];
  if (env.VSCODE_TEST_EXECUTABLE) {
    candidates.push(env.VSCODE_TEST_EXECUTABLE);
  }
  if (platform === 'win32') {
    if (env.LOCALAPPDATA) {
      candidates.push(path.join(env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'));
    }
    if (env.ProgramFiles) {
      candidates.push(path.join(env.ProgramFiles, 'Microsoft VS Code', 'Code.exe'));
    }
  } else if (platform === 'darwin') {
    candidates.push('/Applications/Visual Studio Code.app/Contents/MacOS/Code');
    candidates.push('/Applications/Visual Studio Code.app/Contents/MacOS/Electron');
  } else {
    candidates.push('/usr/share/code/code', '/usr/lib/code/code', '/snap/code/current/usr/share/code/code');
  }
  return candidates.find((p) => existsSync(p));
}
