// The extension's identity (docs/DESIGN.md#store-and-packaging, confirmed by the maintainer on 2026-10-16). Every place that
// uses it reads this file or package.json; test/unit/identity.test.ts checks that the two agree.
export const PUBLISHER = 'haberwooki';
export const EXTENSION_NAME = 'livemd2tex';
export const EXTENSION_ID = `${PUBLISHER}.${EXTENSION_NAME}`;
/** The two data extensions of docs/DESIGN.md#store-and-packaging (B1 builds them; nothing installs them yet). */
export const CORE_DATA_NAME = `${EXTENSION_NAME}-core-data`;
export const EXTRA_DATA_NAME = `${EXTENSION_NAME}-extra-data`;
/** Prefix of every command, setting and view ID, distinct from LaTeX Workshop's (docs/DESIGN.md#confinement-and-trust). */
export const COMMAND_PREFIX = 'livemd2tex';
export const DISPLAY_NAME = 'liveMd2Tex';
/** The repository (private until the public switch); its issue tracker takes "Report a missing package". */
export const REPOSITORY_URL = 'https://github.com/haberwooki/liveMd2Tex';
