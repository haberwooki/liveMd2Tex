// The package commands (docs/DESIGN.md#engine-and-data): "Install Extra Packages" (VS Code's own Extensions view),
// "Add a package from a file" (a .sty, .cls, .dtx with .ins, or a CTAN .zip; a .dtx is built with docstrip on the
// bundled engine as a tool job) and "Report a missing package" (the issue tracker, through VS Code's link prompt).

import { posix } from 'node:path';
import * as vscode from 'vscode';
import { ENGINE_FORMATS, type CompileJob, type ProjectFile } from '../../shared/engineJobs';
import { DISPLAY_NAME, REPOSITORY_URL } from '../../shared/identity';
import type { CompileScheduler } from '../compile/scheduler';
import { dirOf } from '../compile/targets';
import { EXTRA_DATA_ID, type DataResolver } from '../engine/dataResolver';
import type { EngineService } from '../engine/engineService';
import { isMarkdownDocument, isTexDocument } from '../languages';
import { writeBoundary, writeConfined } from '../project/confinedWrite';
import { preparePackages, projectCopies } from './userPackages';

/** Job ids for tool jobs (package builds), apart from the compiles' ids. */
let nextToolJobId = 1_000_000_000;

export interface PackageCommandsOptions {
  data: DataResolver;
  engine: EngineService;
  scheduler: CompileScheduler;
  log: vscode.LogOutputChannel;
}

export class PackageCommands {
  constructor(private readonly options: PackageCommandsOptions) {}

  /**
   * "Install Extra Packages": opens VS Code's own Extensions view on the add-on; the user installs it there, from
   * the store they chose, and the extension downloads nothing (docs/DESIGN.md#engine-and-data).
   */
  async installExtraPackages(): Promise<void> {
    if (this.options.data.extraInstalled()) {
      void vscode.window.showInformationMessage(`${DISPLAY_NAME}: the Extra Packages add-on is already installed.`);
      return;
    }
    await vscode.commands.executeCommand('workbench.extensions.search', `@id:${EXTRA_DATA_ID}`);
  }

  /** "Add a package from a file": the user picks a .sty, .cls, .dtx with .ins, or a CTAN .zip. */
  async addPackageFromFile(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: 'Add package',
      title: `${DISPLAY_NAME}: Add a package from a file (.sty, .cls, .dtx with .ins, or a .zip from CTAN)`,
      filters: { 'TeX packages': ['sty', 'cls', 'dtx', 'ins', 'zip', 'bst', 'clo', 'cfg', 'def', 'fd'] },
    });
    if (!picked?.length) {
      return;
    }
    const doc = vscode.window.activeTextEditor?.document;
    const projectFolder = doc && (isTexDocument(doc) || isMarkdownDocument(doc)) ? dirOf(doc.uri) : undefined;
    let where: 'user' | 'project' = 'user';
    if (projectFolder) {
      const choice = await vscode.window.showQuickPick(
        [
          { label: 'For all my documents', description: 'your package folder', where: 'user' as const },
          { label: 'Only for this project', description: projectFolder.fsPath, where: 'project' as const },
        ],
        { title: 'Where should the package go?' },
      );
      if (!choice) {
        return;
      }
      where = choice.where;
    }
    await this.addPackageFiles(picked, where === 'project' ? projectFolder : undefined);
  }

  /**
   * Runs a package's .ins file (docstrip) on the bundled engine, as a tool job of the scheduler, so a live compile
   * and the build never cancel each other (build gate 2, G2E-01). A build that a cancel still stops is tried once
   * more; any other failure is an error, never "no files".
   */
  private async buildIns(files: ProjectFile[], ins: string): Promise<ProjectFile[]> {
    const job = (id: number): CompileJob => ({
      id,
      main: ins,
      files,
      engine: 'pdflatex',
      bibtex: 'never',
      maxPasses: 1,
      synctex: false,
      steps: [['pdflatex', '-no-shell-escape', '-interaction=nonstopmode', '-fmt', ENGINE_FORMATS.pdflatex, ins]],
      returnNewFiles: true,
    });
    for (let attempt = 1; ; attempt++) {
      const { result } = await this.options.scheduler.runTool(`docstrip ${ins}`, () => this.options.engine.compile(job(nextToolJobId++)));
      if (!result.error) {
        return result.newFiles ?? [];
      }
      if (result.error !== 'cancelled' || attempt === 2) {
        throw new Error(`${ins} could not be built: ${result.error.split('\n')[0]}`);
      }
    }
  }

  /** Adds packages from files: into the user's package folder, or into `projectFolder`. Returns what was added. */
  async addPackageFiles(files: vscode.Uri[], projectFolder?: vscode.Uri): Promise<{ packages: string[]; built: string[] }> {
    const inputs = await Promise.all(files.map(async (uri) => ({ name: posix.basename(uri.path), data: await vscode.workspace.fs.readFile(uri) })));
    let prepared;
    try {
      prepared = await preparePackages(inputs, (projectFiles, ins) => this.buildIns(projectFiles, ins));
    } catch (err) {
      void vscode.window.showErrorMessage(`${DISPLAY_NAME}: the package could not be added: ${err instanceof Error ? err.message : String(err)}`);
      return { packages: [], built: [] };
    }
    if (prepared.files.size === 0) {
      void vscode.window.showWarningMessage(`${DISPLAY_NAME}: none of those files is a package file (.sty, .cls, .bst, ...).`);
      return { packages: [], built: [] };
    }
    if (projectFolder) {
      // Never through a link out of the project (build gate 2, G2S-02).
      const boundary = writeBoundary(vscode.Uri.joinPath(projectFolder, 'x'));
      try {
        for (const f of projectCopies(prepared)) {
          await writeConfined(boundary, vscode.Uri.joinPath(projectFolder, f.path), f.data);
        }
      } catch (err) {
        void vscode.window.showErrorMessage(`${DISPLAY_NAME}: ${err instanceof Error ? err.message : String(err)}`);
        return { packages: [], built: [] };
      }
    } else {
      await this.options.data.user.add(prepared);
    }
    this.options.data.invalidate();
    const built = prepared.built.length ? ` Built ${prepared.built.join(', ')} with docstrip.` : '';
    const notes = prepared.notes.length ? ` ${prepared.notes.join(' ')}` : '';
    this.options.log.info(`added ${prepared.packages.join(', ')} (${prepared.files.size} files) to ${projectFolder ? projectFolder.fsPath : 'the package folder'}`);
    void vscode.window.showInformationMessage(`${DISPLAY_NAME}: added ${prepared.packages.join(', ')}.${built}${notes}`);
    return { packages: prepared.packages, built: prepared.built };
  }

  /** "Report a missing package": the issue tracker in the browser, through VS Code's own link prompt. */
  async reportMissingPackage(): Promise<void> {
    const name = await vscode.window.showInputBox({ title: 'Which package is missing?', prompt: 'The package name, for example siunitx' });
    if (name === undefined) {
      return;
    }
    const title = encodeURIComponent(`Missing package: ${name.trim()}`);
    await vscode.env.openExternal(vscode.Uri.parse(`${REPOSITORY_URL}/issues/new?title=${title}`));
  }
}
