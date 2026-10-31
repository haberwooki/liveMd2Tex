/* dispatcher.c: the main of liveMd2Tex's TeX engine, one WebAssembly file with four programs.
 *
 * Ours (the liveMd2Tex authors), GPL-3.0-or-later, except the lines marked "from BusyTeX" below.
 *
 * The host calls the engine as "<program> <arguments>" (src/engine-host/engine/worker.ts), so argv[0] is the
 * program path the glue was given (thisProgram, "/bin/engine") and argv[1] names the program. main shifts the
 * arguments so that the program sees argv[0] = "/bin/engine" (kpathsea's SELFAUTOLOC then comes from that path,
 * texmfmp.c:822-896) and its own options from argv[1] on. Each program's main was renamed at compile time
 * (-Dmain=<program>_main, engine/build/build.sh). This file sets no environment: the host sets ENV.
 *
 * Lines marked "from BusyTeX" come from BusyTeX's busytex.c at commit eb36aae169f7d71e70760a84ef80156b33c0f820
 * (https://github.com/busytex/busytex), whose README grants them under the MIT License:
 *
 *   BusyTeX (main author: Vadim Kantorov, https://github.com/vadimkantorov). "MIT - applies only to the code and
 *   scripts in the repo, not to the published binaries" (README.md, lines 23-24).
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
 *   documentation files (the "Software"), to deal in the Software without restriction, including without
 *   limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the
 *   Software, and to permit persons to whom the Software is furnished to do so, subject to the following
 *   conditions:
 *
 *   The above copyright notice and this permission notice shall be included in all copies or substantial
 *   portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED
 *   TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
 *   THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
 *   CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 *   DEALINGS IN THE SOFTWARE.
 *
 * The same notice ships as LICENSES/engine/BusyTeX-README-License.txt with LICENSES/MIT.txt.
 */
#include <stdio.h>
#include <string.h>

#include <emscripten/emscripten.h>

extern int optind;

int pdftex_main(int argc, char **argv);
int xetex_main(int argc, char **argv);
int xdvipdfmx_main(int argc, char **argv);
int bibtex8_main(int argc, char **argv);

/* Called by the host after each program run, so that a run's unfinished last line never spills into the next
 * run's transcript. */
EMSCRIPTEN_KEEPALIVE void flush_streams(void)
{
    fputc('\n', stdout); /* from BusyTeX's busytex.c, lines 39-41, MIT */
    fputc('\n', stderr); /* from BusyTeX's busytex.c, lines 39-41, MIT */
    fflush(NULL);        /* from BusyTeX's busytex.c, lines 39-41, MIT */
}

static const struct {
    const char *name;
    int (*run)(int, char **);
} programs[] = {
    {"pdftex", pdftex_main},
    {"pdflatex", pdftex_main},
    {"xetex", xetex_main},
    {"xelatex", xetex_main},
    {"xdvipdfmx", xdvipdfmx_main},
    {"bibtex8", bibtex8_main},
};

int main(int argc, char **argv)
{
    if (argc >= 2) {
        for (size_t i = 0; i < sizeof programs / sizeof programs[0]; i++) {
            if (strcmp(argv[1], programs[i].name) == 0) {
                argv[1] = argv[0];                         /* from BusyTeX's busytex.c, line 108, MIT */
                optind = 1;                                /* from BusyTeX's busytex.c, line 108, MIT */
                return programs[i].run(argc - 1, argv + 1); /* from BusyTeX's busytex.c, line 108, MIT */
            }
        }
    }
    fprintf(stderr, "engine: the first argument names the program: pdftex (pdflatex), xetex (xelatex), xdvipdfmx or "
                    "bibtex8\n");
    return 64;
}
