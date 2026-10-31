#!/usr/bin/env bash
# engine/build/build.sh: builds liveMd2Tex's TeX engine (engine.wasm, engine.js, engine-build.json) from TeX Live's
# source with Emscripten, under Linux (WSL or a GitHub runner). docs/DEVELOPING.md ("The TeX engine: our own build")
# says how to run it and what it checks.
#
# Ours (the liveMd2Tex authors), GPL-3.0-or-later.
#
#   bash engine/build/build.sh --fetch --root DIR --out DIR
#
# Options:
#   --root DIR       the build root (downloads, toolchain, source, build trees); never inside the repository and,
#                    under WSL, never under /mnt/c
#   --out DIR        where engine.wasm, engine.js, engine-build.json and the build log go
#   --fetch          download the pinned archives that are missing from <root>/downloads (anonymous curl)
#   --downloads DIR  take the archives from DIR instead of <root>/downloads (to share them between roots)
#   --from STEP      redo STEP and every step after it (steps: unpack emsdk native fontlist configure texk build
#                    rename link inspect)
#   --assert         also link a debugging copy with -sASSERTIONS=1 (its map under <root>/link/assertions/, its
#                    engine.js and engine.wasm in <out>/assertions/; never shipped)
#   --jobs N         make's parallel jobs (default 6; use at most 6 on a machine with 8 GB of memory or less)
#
# The engine always ships the -g1 link (--no-g1 is refused). -g1 changes no byte of the wasm (the build checks
# it); it keeps the glue's whitespace and comments, and with them the names of the imports: without it Emscripten
# writes each library function into wasmImports in place, so the import check cannot name 43 of the 46 imports,
# the scan's allow-list cannot tell its entries apart in a two-line file, and MiniLZ4's notice drops out of the
# glue.
#
# Variables a variant build may set (each recorded in engine-build.json):
#   OPT            optimisation flag for every compile and the link (default -Oz, the smallest code; the engine ships it)
#   EXTRA_CFLAGS   more flags for every C and C++ compile (TeX Live's configure line)
#   EXTRA_LDFLAGS  more flags for the final link only
# A variant with another OPT or EXTRA_CFLAGS needs its own --root (share the archives with --downloads); one that
# changes only EXTRA_LDFLAGS can reuse a root with --from link and its own --out.
#
# Every step logs to <root>/logs/<step>.log and leaves <root>/stamps/<step>; a run skips the steps already done.
# The build runs under LC_ALL=C, TZ=UTC, SOURCE_DATE_EPOCH (TeX Live's commit time) and PYTHONHASHSEED=0, and every
# compile maps the build root to /src (-ffile-prefix-map), so no path of the build machine reaches the engine.
set -euo pipefail

main() {
  HERE=${LIVEMD2TEX_BUILD_HERE:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}
  REPO=$(cd "$HERE/../.." && pwd)
  PINS="$REPO/engine/engine-build-pins.json"
  ROOT= OUT= FETCH=0 DOWNLOADS= FROM= ASSERT=0 JOBS=${JOBS:-6}
  while [ $# -gt 0 ]; do
    case "$1" in
      --root) ROOT=$2; shift 2 ;;
      --out) OUT=$2; shift 2 ;;
      --fetch) FETCH=1; shift ;;
      --downloads) DOWNLOADS=$2; shift 2 ;;
      --from) FROM=$2; shift 2 ;;
      --assert) ASSERT=1; shift ;;
      --no-g1) echo "build.sh: --no-g1 is refused: the engine ships the -g1 glue (see the header of build.sh)" >&2; exit 2 ;;
      --jobs) JOBS=$2; shift 2 ;;
      -h|--help) sed -n '2,37p' "$HERE/build.sh"; exit 0 ;;
      *) echo "build.sh: unknown option $1" >&2; exit 2 ;;
    esac
  done
  [ -n "$ROOT" ] && [ -n "$OUT" ] || { echo "build.sh: --root and --out are required" >&2; exit 2; }
  mkdir -p "$ROOT" "$OUT"
  ROOT=$(cd "$ROOT" && pwd)
  OUT=$(cd "$OUT" && pwd)
  case "$ROOT/" in "$REPO"/*) echo "build.sh: the build root must be outside the repository" >&2; exit 2 ;; esac
  case "$ROOT" in /mnt/*) echo "build.sh: under WSL the build root must be in the Linux file system (/home/...), not $ROOT" >&2; exit 2 ;; esac
  DOWNLOADS=${DOWNLOADS:-$ROOT/downloads}
  mkdir -p "$DOWNLOADS" "$ROOT/logs" "$ROOT/stamps"

  OPT=${OPT:--Oz}
  EXTRA_CFLAGS=${EXTRA_CFLAGS:-}
  EXTRA_LDFLAGS=${EXTRA_LDFLAGS:-}

  export LC_ALL=C TZ=UTC PYTHONHASHSEED=0
  # The system's own PATH only: no folder of another machine (under WSL, Windows' folders) reaches a configure
  # script, a log or the engine.
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  TL_COMMIT=$(pin texLive.commit)
  SOURCE_DATE_EPOCH=$(date -u -d "$(pin texLive.committed)" +%s)
  export SOURCE_DATE_EPOCH
  umask 022

  TL="$ROOT/tl"
  EMSDK="$ROOT/emsdk"
  NATIVE="$ROOT/native"
  WASM="$ROOT/wasm"
  FONTLIST="$ROOT/fontlist"
  LINK="$ROOT/link"
  TOOLS="$ROOT/native-tools"
  PREFIX_MAP="-ffile-prefix-map=$ROOT=/src"
  COMPILE_FLAGS="$OPT $PREFIX_MAP${EXTRA_CFLAGS:+ $EXTRA_CFLAGS}"

  if [ -n "$FROM" ]; then
    local seen=0
    for s in unpack emsdk native fontlist configure texk build rename link inspect; do
      [ "$s" = "$FROM" ] && seen=1
      [ $seen = 1 ] && rm -f "$ROOT/stamps/$s"
    done
    [ $seen = 1 ] || { echo "build.sh: unknown step $FROM" >&2; exit 2; }
  fi
  # Objects made with other compile flags must not be mixed with these.
  if [ -f "$ROOT/stamps/compile-flags" ] && [ -f "$ROOT/stamps/configure" ] \
     && [ "$(cat "$ROOT/stamps/compile-flags")" != "$COMPILE_FLAGS" ]; then
    echo "build.sh: this root was configured with other compile flags ($(cat "$ROOT/stamps/compile-flags"));" \
         "use another --root or --from configure" >&2
    exit 2
  fi

  local t0=$SECONDS
  check_host
  fetch_and_check
  step unpack do_unpack
  step emsdk do_emsdk
  activate_emsdk
  step native do_native
  step fontlist do_fontlist
  step configure do_configure
  step texk do_texk
  step build do_build
  step rename do_rename
  step link do_link
  step inspect do_inspect
  echo "build.sh: done in $(( SECONDS - t0 )) s; outputs in $OUT"
}

# pin KEY: a value from engine-build-pins.json (dotted path).
pin() {
  python3 -c 'import json,sys
v=json.load(open(sys.argv[1]))
for k in sys.argv[2].split("."): v=v[k]
print(v)' "$PINS" "$1"
}

log() { echo "[$(date -u +%H:%M:%S)] $*"; }

step() {
  local name=$1 fn=$2
  if [ -f "$ROOT/stamps/$name" ]; then
    log "step $name: done before, skipped"
    return 0
  fi
  log "step $name: start (log: logs/$name.log)"
  local t=$SECONDS rc
  # A subshell, not "if ! fn": bash ignores set -e inside a function called as a condition.
  set +e
  ( set -e; "$fn" ) >"$ROOT/logs/$name.log" 2>&1
  rc=$?
  set -e
  if [ $rc -ne 0 ]; then
    echo "build.sh: step $name failed (exit $rc); the end of logs/$name.log:" >&2
    tail -n 40 "$ROOT/logs/$name.log" >&2
    exit 1
  fi
  echo "$(( SECONDS - t ))" >"$ROOT/stamps/$name"
  log "step $name: done in $(( SECONDS - t )) s"
}

check_host() {
  local missing=
  # gawk: kpathsea's paths.h, which is compiled in, is written by awk (texk/kpathsea/Makefile.am:192-201), and
  # Ubuntu's default awk is mawk; both configure runs get AWK=gawk, as on the CI runner.
  for t in gcc g++ make python3 xz curl git tar sha256sum gawk; do
    command -v "$t" >/dev/null 2>&1 || missing="$missing $t"
  done
  [ -z "$missing" ] || { echo "build.sh: missing host tools:$missing (see engine-build-pins.json hostTools)" >&2; exit 2; }
}

# The archives: present and right, or (with --fetch) downloaded and checked.
fetch_and_check() {
  local key
  for key in texLive.archive emsdk.archive emsdk.wasmBinaries emsdk.node; do
    local name url size sha
    name=$(pin "$key.name"); url=$(pin "$key.url"); size=$(pin "$key.size"); sha=$(pin "$key.sha256")
    local file="$DOWNLOADS/$name"
    if [ ! -f "$file" ]; then
      [ $FETCH = 1 ] || { echo "build.sh: $name is missing from $DOWNLOADS; run with --fetch" >&2; exit 2; }
      log "fetch $name"
      curl -fsSL --retry 3 -o "$file.part" "$url"
      mv "$file.part" "$file"
    fi
    local got_size got_sha
    got_size=$(stat -c %s "$file")
    got_sha=$(sha256sum "$file" | cut -d' ' -f1)
    if [ "$got_size" != "$size" ] || [ "$got_sha" != "$sha" ]; then
      echo "build.sh: $name does not match its pin (size $got_size, SHA-256 $got_sha)" >&2
      exit 2
    fi
  done
  log "the four archives match engine-build-pins.json"
}

do_unpack() {
  rm -rf "$TL"
  mkdir -p "$TL"
  tar -xzf "$DOWNLOADS/$(pin texLive.archive.name)" -C "$TL" --strip-components=1
  cd "$TL"
  # The generated files TeX Live's own CI touches after a checkout, so make does not run bison, flex or
  # makeinfo again (TL .github/scripts/build-tl.sh:69-90; a GitHub archive gives every file the same time).
  find . -name '*.info' -exec touch '{}' +
  local f
  for f in texk/detex/detex-src/detex.c texk/detex/detex-src/detex.h \
    texk/gregorio/gregorio-src/src/gabc/gabc-score-determination.c \
    texk/gregorio/gregorio-src/src/gabc/gabc-score-determination.h \
    texk/gregorio/gregorio-src/src/vowel/vowel-rules.h \
    texk/web2c/omegafonts/pl-lexer.c texk/web2c/omegafonts/pl-parser.c texk/web2c/omegafonts/pl-parser.h \
    texk/web2c/otps/otp-lexer.c texk/web2c/otps/otp-parser.c texk/web2c/otps/otp-parser.h \
    texk/web2c/web2c/web2c-lexer.c texk/web2c/web2c/web2c-parser.c texk/web2c/web2c/web2c-parser.h \
    utils/asymptote/camp.tab.cc utils/asymptote/camp.tab.h utils/lacheck/lacheck.c \
    utils/xindy/xindy-src/tex2xindy/tex2xindy.c texk/dvipng/doc/dvipng.1 texk/dvipng/dvipng-src/dvipng.1; do
    [ -e "$f" ] && touch "$f"
  done
  apply_patches
  skip_unused_packages
}

# TeX Live configures every libs/, texk/ and utils/ folder that has an executable configure script, even a disabled
# one, and "the configure must succeed, even if the package has been disabled" (TL m4/kpse-setup.m4:306-308).
# Under --host=wasm32 some cannot (libs/luajit's native helper wants gcc -m32; TeX Live issue 87). TeX Live's own
# advice is to take failing folders out of the tree (doc/tlbuild.texi, "Build one package"); here every folder the
# four programs do not need loses its configure's execute bit, so it is neither configured nor built. The source
# itself is unchanged.
KEEP_PACKAGES="libs/freetype2 libs/graphite2 libs/harfbuzz libs/icu libs/libpaper libs/libpng libs/pplib libs/teckit
  libs/xpdf libs/zlib texk/kpathsea texk/web2c texk/dvipdfm-x texk/bibtex-x"
skip_unused_packages() {
  local d skipped=
  for d in libs/*/ texk/*/ utils/*/; do
    d=${d%/}
    case " $(echo $KEEP_PACKAGES) " in *" $d "*) continue ;; esac
    if [ -x "$d/configure" ]; then
      chmod -x "$d/configure"
      skipped="$skipped $d"
    fi
  done
  echo "not configured:$skipped"
}

apply_patches() {
  local p
  for p in "$HERE"/patches/*.patch; do
    [ -e "$p" ] || continue
    echo "patch: $(basename "$p")"
    patch -p1 -d "$TL" --no-backup-if-mismatch <"$p"
  done
}

do_emsdk() {
  rm -rf "$EMSDK"
  mkdir -p "$EMSDK/downloads"
  tar -xzf "$DOWNLOADS/$(pin emsdk.archive.name)" -C "$EMSDK" --strip-components=1
  # emsdk keeps a download it finds under its own name (emsdk.py, download_file with EMSDK_KEEP_DOWNLOADS).
  cp "$DOWNLOADS/$(pin emsdk.wasmBinaries.name)" "$EMSDK/downloads/"
  cp "$DOWNLOADS/$(pin emsdk.node.name)" "$EMSDK/downloads/"
  cd "$EMSDK"
  local release
  release=$(pin emscripten.release)
  # With the pinned archives in place emsdk downloads nothing ("already downloaded, skipping"); a download would
  # mean an input the pins do not cover, so it fails the step.
  EMSDK_KEEP_DOWNLOADS=1 ./emsdk install "$release" | tee "$EMSDK/install.txt"
  if grep -qi '^Downloading' "$EMSDK/install.txt"; then echo "emsdk downloaded a file the pins do not cover" >&2; return 1; fi
  EMSDK_KEEP_DOWNLOADS=1 ./emsdk activate "$release"
}

activate_emsdk() {
  # shellcheck disable=SC1091
  source "$EMSDK/emsdk_env.sh" >/dev/null 2>&1
  EM_BIN=$(dirname "$(command -v emcc)")
  LLVM_BIN="$EMSDK/upstream/bin"
  NODE=$(command -v node)
  export EM_BIN LLVM_BIN NODE
}

# The WEB tools TeX Live's cross build takes from PATH (m4/kpse-cross.m4:17-24; texk/web2c/configure.ac:388-396).
do_native() {
  rm -rf "$NATIVE" "$TOOLS"
  mkdir -p "$NATIVE" "$TOOLS"
  cd "$NATIVE"
  "$TL/configure" --disable-all-pkgs --enable-missing --without-x --disable-shared --enable-static \
    --disable-native-texlive-build CFLAGS=-O2 CXXFLAGS=-O2 AWK=gawk
  # The first make configures every subfolder and builds nothing, all packages being off (TL doc/tlbuild.texi,
  # "Build one engine"); the four tools are then made by name, kpathsea with them.
  make
  # Serial: with -j, several rules enter texk/web2c/web2c at once and race on its objects (seen with TL
  # 6a300188: "mv: cannot stat '.deps/kps.Tpo'"); the four tools are small.
  make -C texk/web2c tangle ctangle otangle tie
  local t
  for t in tangle ctangle otangle tie; do
    cp "texk/web2c/$t" "$TOOLS/$t"
  done
}

# The stand-in for fontconfig (engine/build/fontlist), built as the libfontconfig.a TeX Live's configure links
# against (m4/kpse-fontconfig-flags.m4:33-49).
do_fontlist() {
  rm -rf "$FONTLIST"
  mkdir -p "$FONTLIST/include/fontconfig" "$FONTLIST/lib"
  cp "$HERE/fontlist/fontconfig/fontconfig.h" "$FONTLIST/include/fontconfig/"
  emcc $COMPILE_FLAGS -Wall -Wextra -I"$FONTLIST/include" -c "$HERE/fontlist/fontlist.c" -o "$FONTLIST/fontlist.o"
  emar crs "$FONTLIST/lib/libfontconfig.a" "$FONTLIST/fontlist.o"
}

do_configure() {
  export PATH="$TOOLS:$PATH"
  rm -rf "$WASM"
  mkdir -p "$WASM"
  cd "$WASM"
  local without=
  local lib
  for lib in cairo freetype2 gd gmp graphite2 harfbuzz icu kpathsea libpaper libpng luajit mpfi mpfr pixman \
    potrace ptexenc teckit zlib zziplib; do
    without="$without --without-system-$lib"
  done
  # No autoconf answers are given: the three BusyTeX's report to TeX Live's build list names
  # (https://tug.org/pipermail/tlbuild/2021q1/004806.html, item 2: ac_cv_func_getwd,
  # ax_cv_c_float_words_bigendian, ac_cv_namespace_ok) are read by no configure script of the folders built here
  # at TeX Live 6a300188 (the float-word test is only in libs/cairo), so the answers an earlier draft gave were inert
  # and were dropped; the wasm stayed the same bytes.
  # --disable-ipc: TeX's --ipc option (texk/web2c/lib/texmfmp.c:1286-1553, 1952) opens a socket to a viewer and
  # may start one with system(); web2c builds it unless told not to (texk/web2c/ac/web2c.ac:26-29; IPC was 1 in
  # c-auto.h), which links socket() and connect() and so Emscripten's SOCKFS into the glue.
  emconfigure "$TL/configure" --host=wasm32-unknown-emscripten --build=x86_64-pc-linux-gnu \
    --disable-all-pkgs --enable-pdftex --enable-xetex --enable-dvipdfm-x --enable-bibtex-x \
    --disable-shared --enable-static --without-x --disable-native-texlive-build --disable-multiplatform \
    $without \
    --with-fontconfig-includes="$FONTLIST/include" --with-fontconfig-libdir="$FONTLIST/lib" \
    --with-banner-add=/liveMd2Tex --disable-ipc \
    CC=emcc CXX=em++ AR=emar RANLIB=emranlib \
    BUILDCC=gcc BUILDCXX=g++ BUILDCFLAGS=-O2 BUILDCXXFLAGS=-O2 CC_BUILD=gcc \
    CFLAGS="$COMPILE_FLAGS" CXXFLAGS="$COMPILE_FLAGS" AWK=gawk
  echo "$COMPILE_FLAGS" >"$ROOT/stamps/compile-flags"
  sed -n 's/^  \$ //p' config.log | head -n 1 >"$ROOT/stamps/configure-line"
  # TeX Live configures its libs/* and texk/* folders from make's "recurse" target (am/recurse.am), which then
  # runs "make all" in each folder that is needed. The libraries are configured and built that way, in TeX Live's
  # order (libpng's configure links against the zlib built before it).
  export CC_BUILD=gcc
  # ICU's configure knows no wasm32 host and stops ("could not detect your platform"; icu-src/source/acinclude.m4,
  # ICU_CHECK_MH_FRAG); its Linux fragment fits a static build, and the cache variable picks it.
  # ICU's own packaging of its data cannot serve a wasm build: on Linux its native pkgdata writes x86 assembly or an
  # ELF object (tools/pkgdata/pkgdata.cpp:725-797), and its C-code mode (pkgdata -w) builds a table of pointers
  # without lengths, which ICU 78's converter alias loader rejects (common/ucnv_io.cpp:250-262; udata_getLength is
  # -1 for such a table, common/ucmndata.cpp pointerTOCLookupFn), so XeTeX stops with "internal error; cannot read
  # font names". ICU's build still makes its C-code library here (data/Makefile.in:26 takes PKGDATA_OPTS from the
  # environment), because TeX Live's wrapper stops without a lib/libicudata.a (libs/icu/Makefile.am, icubuild; a
  # plain data file, PKGDATA_MODE=common, leaves none); build_icu_data then replaces that library with TeX Live's own
  # icudt78l.dat compiled whole.
  export icu_cv_host_frag=mh-linux
  export PKGDATA_OPTS='-O $(top_builddir)/data/icupkg.inc -w'
  make -C libs -j"$JOBS" recurse
  build_icu_data
}

# ICU's data, compiled in whole: ICU's own genccode (the native one TeX Live
# builds for the cross build) turns the data file of TeX Live's ICU source into one C array named as ICU's
# U_ICUDATA_ENTRY_POINT (icudt<major>_dat), which emcc compiles into the libicudata.a that XeTeX links.
build_icu_data() {
  local icu="$WASM/libs/icu" dir="$ROOT/icudata" dat major
  dat=$(ls "$TL"/libs/icu/icu-src/source/data/in/icudt*l.dat)
  major=$(basename "$dat" | sed -E 's/^icudt([0-9]+)l\.dat$/\1/')
  rm -rf "$dir"
  mkdir -p "$dir"
  "$icu/icu-native/bin/genccode" -d "$dir" -e "icudt$major" "$dat"
  emcc $COMPILE_FLAGS -I"$TL/libs/icu/icu-src/source/common" -c "$dir/icudt${major}l_dat.c" -o "$dir/icudt${major}l_dat.o"
  rm -f "$dir/icudt${major}l_dat.c" "$icu/icu-build/lib/libicudata.a"
  emar crs "$icu/icu-build/lib/libicudata.a" "$dir/icudt${major}l_dat.o"
  "$LLVM_BIN/llvm-nm" "$icu/icu-build/lib/libicudata.a" | grep " icudt${major}_dat\$"
}

# texk/: kpathsea is configured and built first, by the top level's own "recurse" (TeX Live's order; the programs'
# configure scripts link their tests against it, dvipdfm-x's "zlib with compress2" among them). The program folders
# are then only configured: their "make all" would link every enabled program on its own.
do_texk() {
  export PATH="$TOOLS:$PATH"
  export CC_BUILD=gcc
  cd "$WASM"
  rm -rf texk/kpathsea texk/web2c texk/bibtex-x texk/dvipdfm-x
  make -j"$JOBS" recurse
  configure_only texk
  drop_libpaper
}

# configure_only DIR: the configure part of am/recurse.am for DIR's CONF_SUBDIRS, with the same command
# (subsubdir-conf.cmd) and the same --disable-build for a folder not in MAKE_SUBDIRS, but without the "make all"
# that follows it there. (Overriding MAKE for that inner make would also reach configure's AC_PROG_MAKE_SET and
# write MAKE=true into every generated Makefile.)
configure_only() {
  local dir=$1 conf make_sub d cmd skip
  conf=$(makevar_needed "$WASM/$dir" CONF_SUBDIRS)
  make_sub=$(makevar "$WASM/$dir" MAKE_SUBDIRS)
  for d in $conf; do
    if [ -f "$WASM/$dir/$d/Makefile" ]; then continue; fi
    mkdir -p "$WASM/$dir/$d"
    cmd=$(sed "s,auxdir/auxsub,$dir/$d,g" "$WASM/subsubdir-conf.cmd")
    case " $make_sub " in *" $d "*) skip= ;; *) skip=' --disable-build' ;; esac
    echo "=== configuring in $dir/$d$skip"
    (cd "$WASM/$dir/$d" && CONFIG_SHELL=/bin/bash && export CONFIG_SHELL && eval "/bin/bash $cmd$skip")
  done
}

# dvipdfmx without libpaper: texk/dvipdfm-x/configure.ac:58 defines HAVE_LIBPAPER without a condition; with it
# undefined dvipdfmx uses its own paper table (dpxconf.h:44-72, default a4). libpaper is GPL-2.0-only.
drop_libpaper() {
  local dir="$WASM/texk/dvipdfm-x"
  grep -q '^#define HAVE_LIBPAPER 1$' "$dir/config.h" || { echo "no HAVE_LIBPAPER line in $dir/config.h" >&2; return 1; }
  sed -i 's|^#define HAVE_LIBPAPER 1$|#undef HAVE_LIBPAPER /* liveMd2Tex: no libpaper (engine/build/build.sh) */|' "$dir/config.h"
  grep -q '^LIBPAPER_LIBS = ' "$dir/Makefile" || { echo "no LIBPAPER_LIBS in $dir/Makefile" >&2; return 1; }
  sed -i -e 's|^LIBPAPER_LIBS = .*$|LIBPAPER_LIBS = |' -e 's|^LIBPAPER_DEPEND = .*$|LIBPAPER_DEPEND = |' \
    -e 's|^LIBPAPER_INCLUDES = .*$|LIBPAPER_INCLUDES = |' "$dir/Makefile"
  grep -n 'LIBPAPER' "$dir/Makefile" "$dir/config.h"
}

# The edit above holds until the link: a rerun of config.status by make would bring HAVE_LIBPAPER back. The map check and the string checks would catch libpaper after the link; this catches it before.
assert_no_libpaper() {
  local dir="$WASM/texk/dvipdfm-x"
  grep -q '^#undef HAVE_LIBPAPER /\* liveMd2Tex' "$dir/config.h" && ! grep -q '^#define HAVE_LIBPAPER' "$dir/config.h" \
    || { echo "texk/dvipdfm-x/config.h defines HAVE_LIBPAPER again" >&2; return 1; }
  grep -q '^LIBPAPER_LIBS = $' "$dir/Makefile" || { echo "texk/dvipdfm-x/Makefile links libpaper again" >&2; return 1; }
}

# makevar DIR VAR: the value of a make variable of a generated Makefile.
makevar() {
  make -s -C "$1" -f Makefile -f "$HERE/print-var.mk" "print-$2" 2>/dev/null
}

# makevar_needed DIR VAR: the same, failing when the value is empty (make would then build its default target).
makevar_needed() {
  local v
  v=$(makevar "$1" "$2")
  [ -n "$v" ] || { echo "make variable $2 of $1 is empty" >&2; return 1; }
  echo "$v"
}

# The objects of each program, and the libraries they need, without the programs' own links. Each program's
# main is renamed for the dispatcher (-Dmain=<program>_main).
do_build() {
  export PATH="$TOOLS:$PATH"
  export CC_BUILD=gcc
  cd "$WASM"
  # (no top-level make: it would also link every enabled program on its own)
  local w2c="$WASM/texk/web2c" dpx="$WASM/texk/dvipdfm-x" bib="$WASM/texk/bibtex-x"
  # web2c's own converters (web2c, fixwrites, splitup, makecpool), configured for the build machine in
  # texk/web2c/web2c, first and serially: under -j several stamp rules build them at once and race on their
  # objects (as in the native step).
  make -C "$w2c/web2c"
  make -C "$w2c" -j"$JOBS" $(makevar "$w2c" pdftex_DEPENDENCIES) $(makevar "$w2c" xetex_DEPENDENCIES)
  make -C "$dpx" -j"$JOBS" $(makevar "$dpx" xdvipdfmx_DEPENDENCIES)
  make -C "$bib" -j"$JOBS" $(makevar "$bib" bibtex8_DEPENDENCIES)
  build_objects "$w2c" pdftex
  build_objects "$w2c" xetex
  build_objects "$dpx" xdvipdfmx
  build_objects "$bib" bibtex8
  assert_no_libpaper
}

# build_objects DIR PROGRAM [EXTRA]: (re)compiles the program's own objects with -Dmain=<program>_main and EXTRA.
build_objects() {
  local dir=$1 prog=$2 extra=${3:-}
  local objs
  objs=$(makevar_needed "$dir" "${prog}_OBJECTS")
  (cd "$dir" && rm -f $objs)
  make -C "$dir" -j"$JOBS" CC="emcc -Dmain=${prog}_main $extra" CXX="em++ -Dmain=${prog}_main $extra" $objs
}

# ---- the four programs in one file: the names that clash, and the ones that stay shared (tools/rename-list.mjs) ----

PROGRAMS="pdftex xetex xdvipdfmx bibtex8"

prog_dir() {
  case $1 in
    pdftex|xetex) echo "$WASM/texk/web2c" ;;
    xdvipdfmx) echo "$WASM/texk/dvipdfm-x" ;;
    bibtex8) echo "$WASM/texk/bibtex-x" ;;
  esac
}

# A program's own archive is linked whole with its objects; every other archive of its LDADD is a library.
own_archives() {
  case $1 in
    pdftex) echo libpdftex.a ;;
    xetex) echo libxetex.a ;;
  esac
}

# program_files PROGRAM: the absolute paths of the program's objects and own archives.
program_files() {
  local dir o a
  dir=$(prog_dir "$1")
  for o in $(makevar_needed "$dir" "${1}_OBJECTS"); do echo "$dir/$o"; done
  for a in $(own_archives "$1"); do echo "$dir/$a"; done
}

all_program_files() {
  local p
  for p in $PROGRAMS; do program_files "$p"; done
}

# abs_in DIR PATH: PATH made absolute against DIR (unless it is absolute already), with its folder resolved.
abs_in() {
  local p=$2
  case $p in /*) ;; *) p="$1/$p" ;; esac
  echo "$(cd "$(dirname "$p")" && pwd)/$(basename "$p")"
}

# library_files: every archive the four programs link, once, absolute, in a fixed order.
library_files() {
  local prog dir w libdirs a
  for prog in $PROGRAMS; do
    dir=$(prog_dir "$prog")
    libdirs=
    for w in $(makevar_needed "$dir" "${prog}_LDADD"); do
      case $w in
        -L*) libdirs="$libdirs ${w#-L}" ;;
        -l*)
          for a in $libdirs; do
            if [ -f "$a/lib${w#-l}.a" ]; then echo "$(cd "$a" && pwd)/lib${w#-l}.a"; fi
          done ;;
        *.la) w=$(abs_in "$dir" "$w"); echo "$(dirname "$w")/.libs/$(basename "$w" .la).a" ;;
        *.a)
          case " $(own_archives "$prog") " in *" $w "*) continue ;; esac
          abs_in "$dir" "$w" ;;
      esac
    done
  done | awk '!seen[$0]++'
}

lib_label() {
  local rel=${1#"$ROOT"/}
  echo "$rel" | sed -e 's|/\.libs/|/|' -e 's|\.a$||' -e 's|[^A-Za-z0-9]\{1,\}|-|g'
}

nm_programs() {
  local prog
  for prog in $PROGRAMS; do
    "$LLVM_BIN/llvm-nm" -A --extern-only --defined-only $(program_files "$prog") >"$1/prog.$prog.defined.txt" 2>/dev/null || true
  done
}

json_get() {
  "$NODE" -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log(eval(process.argv[2]))' "$1" "$2"
}

# The renaming programs' objects as the build step made them (plain, with -Dmain only), and pdftexd.h as web2c
# wrote it: a rerun of the rename step starts from them again.
plain_objects() {
  local header="$WASM/texk/web2c/pdftexd.h" prog dir a objs
  if [ ! -f "$header.orig" ]; then cp "$header" "$header.orig"; fi
  if [ ! -f "$ROOT/stamps/objects-renamed" ]; then return 0; fi
  cp "$header.orig" "$header"
  for prog in pdftex xdvipdfmx bibtex8; do
    dir=$(prog_dir "$prog")
    build_objects "$dir" "$prog"
    for a in $(own_archives "$prog"); do
      objs=$(makevar "$dir" "$(echo "${a%.a}" | tr -c 'A-Za-z0-9\n' '_')_a_OBJECTS")
      (cd "$dir" && rm -f $objs "$a")
      make -C "$dir" -j"$JOBS" "$a"
    done
  done
  rm -f "$ROOT/stamps/objects-renamed"
}

do_rename() {
  export PATH="$TOOLS:$PATH"
  plain_objects
  rm -rf "$LINK"
  mkdir -p "$LINK/nm"
  emcc $COMPILE_FLAGS -Wall -Wextra -c "$HERE/dispatcher.c" -o "$LINK/dispatcher.o"
  emcc $COMPILE_FLAGS -Wall -Wextra -c "$HERE/stubs.c" -o "$LINK/stubs.o"
  library_files >"$LINK/libraries.txt"
  while read -r lib; do
    if [ ! -f "$lib" ]; then echo "library $lib does not exist" >&2; return 1; fi
  done <"$LINK/libraries.txt"
  echo "libraries:"
  sed "s|$ROOT|<root>|" "$LINK/libraries.txt"
  "$NODE" -e 'const fs=require("fs"); fs.writeFileSync(process.argv[2], JSON.stringify(fs.readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean)))' \
    "$LINK/libraries.txt" "$LINK/nm/libraries.json"
  local lib prog n
  while read -r lib; do
    "$LLVM_BIN/llvm-nm" -A --extern-only --defined-only "$lib" >"$LINK/nm/lib.$(lib_label "$lib").defined.txt" 2>/dev/null || true
    "$LLVM_BIN/llvm-nm" -A --extern-only --undefined-only "$lib" >"$LINK/nm/lib.$(lib_label "$lib").undefined.txt" 2>/dev/null || true
  done <"$LINK/libraries.txt"
  nm_programs "$LINK/nm"
  "$NODE" "$HERE/tools/rename-list.mjs" candidates "$LINK/nm"
  # The trial link: the plain programs together. It fails on their clashes; wasm-ld's --trace-symbol lines say
  # which linked library members use each traced name, which decides the shared names.
  local trace_flags=
  for n in $(json_get "$LINK/nm/candidates.json" 'j.traced.join(" ")'); do trace_flags="$trace_flags -Wl,--trace-symbol=$n"; done
  set +e
  em++ -o "$LINK/trial.js" "$LINK/dispatcher.o" "$LINK/stubs.o" \
    -Wl,--whole-archive $(all_program_files) -Wl,--no-whole-archive \
    $(cat "$LINK/libraries.txt") $trace_flags -Wl,--error-limit=0 >"$LINK/nm/trace.txt" 2>&1
  set -e
  echo "trial link: $(grep -c 'duplicate symbol' "$LINK/nm/trace.txt" || true) duplicate symbols, $(grep -c 'reference to' "$LINK/nm/trace.txt" || true) traced references"
  "$NODE" "$HERE/tools/rename-list.mjs" lists "$LINK/nm" "$LINK"
  # Shared names: every program but XeTeX declares them extern. The idea is BusyTeX's (EXTERN to extern in
  # pdftexd.h, its Makefile lines 88, 100 and 401); this edit is ours.
  local header="$WASM/texk/web2c/pdftexd.h" count
  for n in $(json_get "$LINK/rename-lists.json" 'j.shared.map((s) => s.name).join(" ")'); do
    count=$(grep -c "^EXTERN .*[ *]$n *;\$" "$header" || true)
    [ "$count" = 1 ] || { echo "shared $n: $count EXTERN lines in pdftexd.h, expected 1" >&2; return 1; }
    sed -i -E "s/^EXTERN (.*[ *])$n( *);\$/extern \\1$n\\2;/" "$header"
    count=$(grep -c "^extern .*[ *]$n *;\$" "$header" || true)
    [ "$count" = 1 ] || { echo "shared $n: the extern edit failed" >&2; return 1; }
    echo "pdftexd.h: $n is extern"
  done
  # The recompile of each renaming program with its rename header.
  local dir inc a objs
  touch "$ROOT/stamps/objects-renamed"
  for prog in pdftex xdvipdfmx bibtex8; do
    dir=$(prog_dir "$prog")
    inc="-include $LINK/rename-$prog.h"
    build_objects "$dir" "$prog" "$inc"
    for a in $(own_archives "$prog"); do
      objs=$(makevar "$dir" "$(echo "${a%.a}" | tr -c 'A-Za-z0-9\n' '_')_a_OBJECTS")
      (cd "$dir" && rm -f $objs "$a")
      make -C "$dir" -j"$JOBS" CC="emcc -Dmain=${prog}_main $inc" CXX="em++ -Dmain=${prog}_main $inc" "$a"
    done
  done
  # The check after the recompile: no clash is left outside the shared list.
  mkdir -p "$LINK/nm-after"
  cp "$LINK"/nm/lib.* "$LINK/nm/libraries.json" "$LINK/nm-after/"
  nm_programs "$LINK/nm-after"
  "$NODE" "$HERE/tools/rename-list.mjs" verify "$LINK/nm-after" "$LINK/rename-lists.json"
}

LINK_FLAGS_BASE="-sINITIAL_MEMORY=64MB -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=576MB -sSTACK_SIZE=8MB -Wl,--stack-first -sEXIT_RUNTIME=0 -sINVOKE_RUN=0 -sMODULARIZE=1 -sEXPORT_NAME=createEngine -sLZ4=1 -sFORCE_FILESYSTEM=1 -sENVIRONMENT=node -sEXPORTED_FUNCTIONS=_main,_flush_streams -sEXPORTED_RUNTIME_METHODS=callMain,FS,ENV,LZ4,HEAPU8,HEAP32"

# link_engine DIR FLAGS...: one link of the engine into DIR/engine.js and DIR/engine.wasm, with its map. The
# programs' objects and own archives are linked whole, so a duplicate definition fails the link; the
# default ERROR_ON_UNDEFINED_SYMBOLS=1 stays, so a missing function fails it too.
link_engine() {
  local dir=$1
  shift
  mkdir -p "$dir"
  em++ -o "$dir/engine.js" "$LINK/dispatcher.o" "$LINK/stubs.o" \
    -Wl,--whole-archive $(all_program_files) -Wl,--no-whole-archive \
    $(cat "$LINK/libraries.txt") \
    $OPT $LINK_FLAGS_BASE "$@" $EXTRA_LDFLAGS -Wl,-Map="$dir/engine.map"
}

# The flags of the link that ships, after LINK_FLAGS_BASE.
SHIP_FLAGS="-sASSERTIONS=0 -g1"

do_link() {
  export PATH="$TOOLS:$PATH"
  assert_no_libpaper
  rm -rf "$LINK/g1" "$LINK/nog1" "$LINK/control" "$LINK/assertions" "$OUT/assertions"
  link_engine "$LINK/g1" $SHIP_FLAGS
  # The same link without -g1: the wasm must be the same bytes (only the glue differs).
  link_engine "$LINK/nog1" -sASSERTIONS=0
  "$NODE" "$HERE/tools/link-report.mjs" g1 "$LINK"
  cp "$LINK/g1/engine.js" "$LINK/g1/engine.wasm" "$OUT/"
  ROOT="$ROOT" "$NODE" "$HERE/tools/link-report.mjs" map "$LINK/g1/engine.map" "$LINK"
  ROOT="$ROOT" "$NODE" "$HERE/tools/link-report.mjs" musl "$LINK/g1/engine.map" "$LINK" "$REPO/LICENSES/engine/musl-file-notices.txt"
  ROOT="$ROOT" OPT="$OPT" COMPILE_FLAGS="$COMPILE_FLAGS" LINK_FLAGS_BASE="$LINK_FLAGS_BASE" SHIP_FLAGS="$SHIP_FLAGS" \
    EXTRA_CFLAGS="$EXTRA_CFLAGS" EXTRA_LDFLAGS="$EXTRA_LDFLAGS" "$NODE" "$HERE/tools/link-report.mjs" flags "$LINK"
  # The positive controls of the import check: a small program that calls libc's
  # system(), without our stubs, linked with the shipped link's flags (-g1 included), where the deny list must
  # catch __emscripten_system by name, and once without -g1, where the unnamed-import rule must catch it.
  mkdir -p "$LINK/control"
  printf '%s\n' '#include <stdlib.h>' 'int main(int argc, char **argv) { (void)argv; return system(argc > 5 ? "x" : 0); }' \
    'void flush_streams(void) {}' >"$LINK/control/control.c"
  emcc $COMPILE_FLAGS -c "$LINK/control/control.c" -o "$LINK/control/control.o"
  mkdir -p "$LINK/control/g1" "$LINK/control/nog1"
  em++ -o "$LINK/control/g1/engine.js" "$LINK/control/control.o" $OPT $LINK_FLAGS_BASE $SHIP_FLAGS $EXTRA_LDFLAGS
  em++ -o "$LINK/control/nog1/engine.js" "$LINK/control/control.o" $OPT $LINK_FLAGS_BASE -sASSERTIONS=0 $EXTRA_LDFLAGS
  if [ "$ASSERT" = 1 ]; then
    # Its map holds the build root's paths, so it stays under <root>/link.
    link_engine "$LINK/assertions" -sASSERTIONS=1
    mkdir -p "$OUT/assertions"
    cp "$LINK/assertions/engine.js" "$LINK/assertions/engine.wasm" "$OUT/assertions/"
  fi
}

# The C and headers that TeX Live's build generated and the engine compiled (web2c's output, the config.h, c-auto.h
# and paths.h files), copied to <out>/generated-sources, so a difference between two builds can be traced to the
# host tool that wrote it. pdftexd.h is the edited one; pdftexd.h.orig is web2c's.
collect_generated() {
  local dest="$OUT/generated-sources" f
  rm -rf "$dest"
  mkdir -p "$dest"
  cd "$WASM"
  {
    find . \( -name config.h -o -name c-auto.h -o -name paths.h \) -type f
    for f in pdftex0.c pdftexini.c pdftexd.h pdftexd.h.orig pdftexcoerce.h pdftex-pool.c \
      xetex0.c xetexini.c xetexd.h xetexcoerce.h xetex-pool.c; do
      if [ -f "texk/web2c/$f" ]; then echo "./texk/web2c/$f"; fi
    done
  } | LC_ALL=C sort -u | while read -r f; do
    mkdir -p "$dest/$(dirname "$f")"
    cp "$f" "$dest/$f"
  done
  echo "generated sources: $(find "$dest" -type f | wc -l) files"
  # A file that names the build root differs between machines by that path alone; say which.
  grep -rlF "$ROOT" "$dest" | sed "s|$dest/||; s|^|names the build root: |" || true
}

do_inspect() {
  collect_generated
  "$NODE" "$HERE/tools/write-manifest.mjs" --root "$ROOT" --out "$OUT" --pins "$PINS" --repo "$REPO"
  # The safety checks on what ships (tools/wasm-inspect.mjs --check); a failure fails the build.
  "$NODE" "$HERE/tools/wasm-inspect.mjs" "$OUT" --check
}

# Bash reads a script while it runs it, so an edit to this file during a build would change the running build.
# The build therefore runs from a copy.
if [ -z "${LIVEMD2TEX_BUILD_HERE:-}" ]; then
  LIVEMD2TEX_BUILD_HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  export LIVEMD2TEX_BUILD_HERE
  copy=$(mktemp "${TMPDIR:-/tmp}/livemd2tex-build.XXXXXX.sh")
  trap 'rm -f "$copy"' EXIT
  cp "${BASH_SOURCE[0]}" "$copy"
  rc=0
  bash "$copy" "$@" || rc=$?
  exit $rc
fi
main "$@"
exit $?
