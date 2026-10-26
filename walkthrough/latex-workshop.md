<!-- A step of the getting-started walkthrough (docs/DESIGN.md#help-for-new-users, #confinement-and-trust).
Written by the project (GPL-3.0-or-later, as the rest of the repository). -->

# Working beside LaTeX Workshop

If you use LaTeX Workshop, keep it: the two extensions do different jobs.

- **LaTeX Workshop** gives you completion for commands, environments, labels and citations, and the outline
  of your document. These need no TeX installation.
- **liveMd2Tex** builds the PDF with its own TeX inside the extension, and shows the preview as you type.

The first time you open a `.tex` file in a folder, liveMd2Tex asks one question: turn off LaTeX Workshop's
automatic build for this folder? Say yes, and each change builds once instead of twice. Only this folder's
setting changes; LaTeX Workshop's completion and outline keep working. You can turn its build back on in the
folder's settings (`latex-workshop.latex.autoBuild.run`).

The two do not share keys. liveMd2Tex's keys start with Shift+Alt, or work only inside its preview. PDF files
still open in LaTeX Workshop's viewer when you open them from the Explorer.
