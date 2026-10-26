// The data resolver of docs/DESIGN.md#store-and-packaging for packages: the core data inside this extension (until the core-data
// package exists), the optional Extra Packages add-on found with extensions.getExtension (never a dependency, so
// nothing is fetched), its version and engine checks, and the user's package folder. The result is the package
// context of each compile (compile/pipeline.ts). A data set that does not fit gives one plain message.

import * as path from 'node:path';
import * as vscode from 'vscode';
import { DISPLAY_NAME, EXTRA_DATA_NAME, PUBLISHER } from '../../shared/identity';
import type { PackageContext } from '../compile/pipeline';
import { UserPackages } from '../packages/userPackages';
import { packageContext, readCoreData, readDataExtension } from './dataSets';

export const EXTRA_DATA_ID = `${PUBLISHER}.${EXTRA_DATA_NAME}`;

export class DataResolver implements vscode.Disposable {
  private current: Promise<PackageContext> | undefined;
  private readonly told = new Set<string>();
  private readonly subscription: vscode.Disposable;
  readonly user: UserPackages;
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires when the installed data sets change (the add-on installed or removed, a package added). */
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly extensionPath: string,
    globalStorage: vscode.Uri,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.user = new UserPackages(path.join(globalStorage.fsPath, 'packages'));
    this.subscription = vscode.extensions.onDidChange(() => this.invalidate());
  }

  invalidate(): void {
    this.current = undefined;
    this.changed.fire();
  }

  /** Whether the Extra Packages add-on is installed (and enabled). */
  extraInstalled(): boolean {
    return vscode.extensions.getExtension(EXTRA_DATA_ID) !== undefined;
  }

  get(): Promise<PackageContext> {
    this.current ??= this.resolve();
    return this.current;
  }

  private async resolve(): Promise<PackageContext> {
    const core = await readCoreData(path.join(this.extensionPath, 'dist', 'data'));
    const installed: PackageContext['installed'] = [];
    const extra = vscode.extensions.getExtension(EXTRA_DATA_ID);
    if (extra && core) {
      const found = await readDataExtension(extra.extensionPath, EXTRA_DATA_NAME, {
        texLive: core.manifest.texLive,
        abi: core.manifest.abi,
        snapshot: core.manifest.snapshot,
      });
      const overlap = 'problem' in found || !core.index ? [] : Object.keys(found.set.index.files).filter((f) => f in (core.index as { files: Record<string, string> }).files);
      if ('problem' in found) {
        this.tell(found.problem);
      } else if (overlap.length > 0) {
        // It would be searched before the core and change the core's files for every document (G2E-R3).
        this.tell(`The Extra Packages add-on holds ${overlap.length} file(s) the core already has (${overlap.slice(0, 3).join(', ')}); it is not used. Update both to the same release.`);
      } else {
        installed.push(found);
        this.log.info(`using the Extra Packages add-on ${extra.packageJSON?.version ?? ''} (${Object.keys(found.set.index.packages).length} packages)`);
      }
    }
    const user = await this.user.set();
    if (user) {
      installed.push(user);
    }
    return packageContext(core ? { index: core.index, elsewhere: core.elsewhere } : null, installed);
  }

  private tell(message: string): void {
    if (!this.told.has(message)) {
      this.told.add(message);
      this.log.warn(message);
      void vscode.window.showWarningMessage(`${DISPLAY_NAME}: ${message}`);
    }
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }
}
