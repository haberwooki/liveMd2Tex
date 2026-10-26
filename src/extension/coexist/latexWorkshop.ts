// LaTeX Workshop coexistence (docs/DESIGN.md#confinement-and-trust). Many users have LaTeX Workshop; the two
// extensions must not fight:
//   - detect it, and offer once per workspace to turn its automatic build off for that workspace (both would
//     build on each save); never change its settings without the user's yes, and only at workspace level;
//   - avoid its keybindings, use our own command and setting prefix and our own diagnostics collection;
//   - register no *.pdf custom editor: our viewer is never the default for PDF files (LaTeX Workshop registers
//     one at default priority);
//   - leave it completion and the outline (we have neither in v1.0; the README's "Beside LaTeX Workshop" says so).
// The decision is pure (a host object stands for VS Code), so unit tests check it with a fake extension.

export const LATEX_WORKSHOP_ID = 'James-Yu.latex-workshop';
/** LaTeX Workshop's auto-build setting, under its "latex-workshop" section; "never" turns it off. */
export const AUTO_BUILD_SECTION = 'latex-workshop';
export const AUTO_BUILD_KEY = 'latex.autoBuild.run';

export interface CoexistenceHost {
  /** LaTeX Workshop is installed (VS Code has an extension object for it). */
  installed(): boolean;
  /** A folder or workspace is open (a setting can be written for it). */
  hasWorkspace(): boolean;
  /** The offer was made in this workspace before. */
  offered(): boolean;
  markOffered(): Promise<void>;
  /** The effective value of LaTeX Workshop's auto-build setting here. */
  autoBuild(): string | undefined;
  /** Shows the question; resolves with the chosen answer, or undefined when dismissed. */
  ask(message: string, yes: string, no: string): Promise<string | undefined>;
  /** Writes "never" at workspace level (never user level). */
  turnOffAutoBuildInWorkspace(): Promise<void>;
  log?(line: string): void;
}

export type OfferOutcome = 'not-installed' | 'no-workspace' | 'already-offered' | 'already-off' | 'declined' | 'turned-off';

export const OFFER_MESSAGE =
  'LaTeX Workshop is installed and also builds .tex files as you work, so each change would build twice. ' +
  "Turn off LaTeX Workshop's automatic build for this workspace? Its completion and outline keep working.";
export const OFFER_YES = 'Turn off its auto-build here';
export const OFFER_NO = 'Keep both';

/** Offers once per workspace to turn LaTeX Workshop's auto-build off; changes nothing without a yes. */
export async function offerAutoBuildOff(host: CoexistenceHost): Promise<OfferOutcome> {
  if (!host.installed()) {
    return 'not-installed';
  }
  host.log?.('LaTeX Workshop is installed: our commands, settings and diagnostics keep their own prefix');
  if (!host.hasWorkspace()) {
    return 'no-workspace';
  }
  if (host.offered()) {
    return 'already-offered';
  }
  if (host.autoBuild() === 'never') {
    return 'already-off';
  }
  // Marked before asking: a dismissed question is not asked again.
  await host.markOffered();
  const answer = await host.ask(OFFER_MESSAGE, OFFER_YES, OFFER_NO);
  if (answer !== OFFER_YES) {
    return 'declined';
  }
  await host.turnOffAutoBuildInWorkspace();
  return 'turned-off';
}

/** A keybinding's key as a list of chords, each with its modifiers sorted ("Ctrl+Alt+J" -> ["alt+ctrl+j"]). */
export function chords(key: string): string[] {
  return key
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((chord) => chord.split('+').sort().join('+'));
}

/**
 * True when two keybindings can collide: the same chords, or one a leading part of the other (a single key
 * that starts another's chord sequence takes the sequence over).
 */
export function keysCollide(a: string, b: string): boolean {
  const x = chords(a);
  const y = chords(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    if (x[i] !== y[i]) {
      return false;
    }
  }
  return true;
}
