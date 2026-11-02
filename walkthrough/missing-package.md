<!-- A step of the getting-started walkthrough (docs/DESIGN.md#help-for-new-users, #engine-and-data).
Written by the project (GPL-3.0-or-later, as the rest of the repository). -->

# When a package is missing

The extension carries the LaTeX packages that most documents use, the classes of its starting documents among
them. Many other classes and less common packages come with the free **Extra Packages** add-on, from the same
store.

Before a document compiles, the extension checks what it loads. When the document loads something the extension
does not carry, for example `\documentclass{memoir}`, the Problems panel names the missing file, `memoir.cls`,
and says where to get it. A notification says the same.

There are three ways to get a missing package:

- **Install Extra Packages** opens VS Code's Extensions view on the add-on. You install it there, from the
  store. The extension itself downloads nothing.
- **Add a package from a file** takes a `.sty` or `.cls` file, a `.dtx` file with its `.ins` file, or a ZIP
  file from CTAN (ctan.org). A `.dtx` package is built with the extension's own TeX. The package is kept for all
  your documents, or put in this document's folder.
- You can also copy the package's files into the document's folder.

Some packages need a program outside TeX: `minted` needs Python, and `svg` needs Inkscape. The extension never
runs other programs, so the Problems panel says what to use instead.
