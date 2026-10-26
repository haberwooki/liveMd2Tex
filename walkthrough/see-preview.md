<!-- A step of the getting-started walkthrough (docs/DESIGN.md#help-for-new-users, #live-behaviour, #sync).
Written by the project (GPL-3.0-or-later, as the rest of the repository). -->

# See the preview

The PDF beside the editor follows what you write.

- **Type.** Stop typing for a second, and the preview shows the change. You do not need to save.
- **Save.** A save makes the full PDF, with the bibliography brought up to date, and writes `main.pdf`
  next to `main.tex`.
- **From the PDF to the text.** Double-click a word in the preview, or Ctrl+click it (Cmd+click on macOS). The
  editor goes to that line and selects the word.
- **From the text to the PDF.** Put the cursor on a line and press Shift+Alt+J. The preview scrolls there and
  marks the line for a moment.
- **Mistakes.** A mistake is underlined in the editor and listed in the Problems panel (Ctrl+Shift+M), with a
  sentence in plain words on what usually causes it. The preview keeps the last good PDF until you fix it.

Try a mistake: in `main.tex`, change `\section{Method}` to `\sectoin{Method}`. The Problems panel says that
TeX does not know the command `\sectoin`. Change it back, and the preview is up to date again.

The status bar shows **Live**. Click it to switch to **On save**, and the PDF is then made only when you save.

In the preview, Alt+PageDown and Alt+PageUp turn the pages, and Ctrl+= and Ctrl+- zoom.
