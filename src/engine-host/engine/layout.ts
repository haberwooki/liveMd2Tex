// The parts of a compile worker's set-up that unit tests check without an engine (src/engine-host/engine/worker.ts):
// the memory header rule and the font list the worker writes from the mounted images.

/** The memory restored after each tool: its first 64 MiB, as BusyTeX's busytex_pipeline.js does (MIT). */
export const HEADER_BYTES = 2 ** 26;

/**
 * Throws when the engine's memory has grown past HEADER_BYTES before the header is saved: what lies above it
 * would not be restored after each program, and the next program would start on another program's memory.
 * (BusyTeX's busytex_pipeline.js checks the same in another form; MIT.)
 */
export function headerProblem(heapBytes: number): void {
  if (heapBytes !== HEADER_BYTES) {
    throw new Error(`The TeX engine cannot start: its memory is ${heapBytes} bytes before the first program, not ${HEADER_BYTES}. This engine build does not fit the host; reinstall the extension.`);
  }
}

/**
 * An image's own font list (scripts/lib/font-list.mjs, written by the data builder), by the image's file names:
 * the core's at its texmf root, an add-on's at its top. Each line's path is one of the image's file names.
 */
export const FONT_LIST_IN_IMAGE = { core: '/texlive/texmf-dist/fonts/xetex-fonts.tsv', extra: '/fonts/xetex-fonts.tsv' };

/**
 * The font list XeTeX's fontconfig stand-in reads (engine/build/fontlist), from the mounted images' own lists in
 * mount order (the core first): each line with its image's mount root in front of the path, its first field. The
 * data builder checked that order for collisions (scripts/lib/font-list.mjs, joinSets).
 */
export function fontListText(lists: { root: string; text: string }[]): string {
  const lines: string[] = [];
  for (const { root, text } of lists) {
    for (const line of text.split('\n')) {
      if (line.trim()) {
        // A comment line stays as it is: the mount root goes in front of a path only.
        const plain = line.replace(/\r$/, '');
        lines.push(plain.startsWith('#') ? plain : `${root}${plain}`);
      }
    }
  }
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

/**
 * The variables a tool or a test may set over the engine's environment (EngineAssetPaths.env, WorkerSetup.env): the
 * font list's collision report and the fixed dates a comparison of two runs needs. Shell escape, the search paths
 * and the mktex switches are never among them; the extension sets none.
 */
export const ENV_OVERRIDES: ReadonlySet<string> = new Set(['LIVEMD2TEX_FONT_LIST_CHECK', 'SOURCE_DATE_EPOCH', 'FORCE_SOURCE_DATE']);

/** Throws when an environment override names a variable ENV_OVERRIDES does not allow. */
export function checkEnvOverrides(env: Record<string, string> | undefined): void {
  const refused = Object.keys(env ?? {}).filter((k) => !ENV_OVERRIDES.has(k));
  if (refused.length > 0) {
    throw new Error(`The engine's environment cannot be set for ${refused.join(', ')}: only ${[...ENV_OVERRIDES].join(', ')} may be.`);
  }
}
