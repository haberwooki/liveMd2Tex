# TeX error fixtures

One small document per error that has plain-words help (`src/extension/diagnostics/errorHelp.ts`); each makes that
error happen. Written for this project's tests and dedicated to the public domain (CC0 1.0). Test inputs only;
none of these files ships in the extension package. `variants/` holds the same errors in harder places (an
undefined command inside a macro or an argument), where the help must still name the right command.
