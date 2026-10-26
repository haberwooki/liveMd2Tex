<!-- A step of the getting-started walkthrough (docs/DESIGN.md#help-for-new-users, #engine-and-data).
Written by the project (GPL-3.0-or-later, as the rest of the repository). -->

# When a package is missing

The extension carries the LaTeX packages that most documents use. Many journal classes and less common
packages come with the free **Extra Packages** add-on, from the same store.

1. Click **Make a Physical Review paper** on the left, and choose a folder.
2. Before it compiles, the extension checks what the document loads. The Problems panel names the missing
   class, `revtex4-2.cls`, and says where to get it. A notification says the same.

There are three ways to get a missing package:

- **Install Extra Packages** opens VS Code's Extensions view on the add-on. You install it there, from the
  store. The extension itself downloads nothing.
- **Add a package from a file** takes a `.sty` or `.cls` file, a `.dtx` file with its `.ins` file, or a ZIP
  file from CTAN (ctan.org). A `.dtx` package is built with the extension's own TeX. The package is kept for all
  your documents, or put in this document's folder.
- You can also copy the package's files into the document's folder.

Some packages need a program outside TeX: `minted` needs Python, and `svg` needs Inkscape. The extension never
runs other programs, so the Problems panel says what to use instead.
