# The timed walkthrough test (by hand)

The M4 exit check that a machine cannot run (docs/DESIGN.md#help-for-new-users): a person who has not used the
extension reaches a PDF from the walkthrough alone in under 10 minutes. Two people take it: the maintainer and
one outside tester. Each takes it once, on their own computer. Results are kept outside the repository, with no
names in it.

## Before the clock starts (the observer does this)

1. Build the test copy: `node scripts/vsix-scan.mjs --test-copy` (it lands in `out/vsix/`).
2. Make a fresh, throwaway VS Code profile and install the test copy into it only:
   `code --user-data-dir DIR --extensions-dir DIR/ext --install-extension FILE`.
   Install nothing else. Do not install TeX.
3. Start VS Code with the same two folders, with no folder open. Close any page that opens by itself.
4. Have a stopwatch ready and something to write on.

## The test

1. Say only this: "Use the walkthrough 'Get started with liveMd2Tex' to make a PDF. It is on VS Code's Welcome
   page (Help > Welcome). Think aloud if you like. I cannot help."
2. Start the clock when the tester first touches the mouse or keyboard.
3. Do not help. If the tester asks something, say "Do what you would do alone", and write the question down.
4. Stop the first time when a PDF of the sample shows in the preview: that is the time to a PDF.
5. Let the tester go on through the other four steps, if they want to, and stop the clock again at the end
   (or after 20 minutes).

## What to write down

| What | |
|---|---|
| Date, operating system, VS Code version, extension version | |
| Time to the first PDF (min:s) | |
| Time through all five steps (min:s), or the step reached | |
| Where the tester stopped or hesitated, and for how long | |
| Questions asked | |
| Error messages or pop-ups seen | |
| Anything the walkthrough said that was not what the tester saw | |

The check passes when both testers reach a PDF in under 10 minutes. A step where both hesitated is a change to
the walkthrough, even when the time passes.

## Afterwards

Delete the throwaway profile folders. The PDF and the sample folder the tester made can be deleted too.
