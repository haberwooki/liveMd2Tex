// THE ONE FORK FILE (docs/DESIGN.md#rules, #architecture).
//
// This is the only source file in the extension that may import child_process (enforced by ESLint, by the
// process stub in tests, and by the VSIX scan, which allows child_process only in the bundle built from this
// file, dist/fork.js). It starts one kind of process: the engine host, which is the extension's own
// JavaScript run by the program that runs the extension host. Inside VS Code that program is VS Code's own
// executable, started in Node mode with ELECTRON_RUN_AS_NODE=1, as VS Code's code.cmd and the language-server
// client do. Nothing here starts a shell or any other program.

import { fork, type ChildProcess } from 'node:child_process';

export interface ForkEngineHostOptions {
  /** Absolute path of the engine-host bundle (dist/engine-host.js). */
  modulePath: string;
  /** Node flags for the child. Empty in production; tests pass the stubs here with --require. */
  execArgv?: readonly string[];
  /** The program to run. Defaults to process.execPath: VS Code's executable in the extension host. */
  execPath?: string;
  /**
   * 'advanced' (the default) passes typed arrays without JSON. It needs the same V8 on both sides, which holds
   * in production (the parent and the child are the same program); a test that runs the child under a
   * different program than the parent passes 'json'.
   */
  serialization?: 'advanced' | 'json';
}

export function forkEngineHost(options: ForkEngineHostOptions): ChildProcess {
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  // A user's NODE_OPTIONS must not load code into the engine host.
  delete env.NODE_OPTIONS;
  return fork(options.modulePath, [], {
    execPath: options.execPath ?? process.execPath,
    execArgv: [...(options.execArgv ?? [])],
    env,
    serialization: options.serialization ?? 'advanced',
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
}
