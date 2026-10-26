# Shell-escape fixtures

Two small documents that load graphicx and hyperref, one with an .eps figure and one without. They test the rule
that epstopdf's "Shell escape feature is not enabled" note is shown only when the project has an .eps file, and
the help for an .eps figure that was not turned into PDF (`src/extension/diagnostics/errorHelp.ts`). Written for
this project's tests and dedicated to the public domain (CC0 1.0). Test inputs only; none of these files ships in
the extension package.
