/* fontconfig/fontconfig.h: liveMd2Tex's stand-in for the part of fontconfig that XeTeX calls.
 *
 * Ours (the liveMd2Tex authors), GPL-3.0-or-later. Not copied from fontconfig: the names below are the ones
 * XeTeX's source uses (TeX Live 6a300188, texk/web2c/xetexdir/XeTeXFontMgr_FC.cpp lines 89-92, 165-171, 198-202,
 * 212-217, 247, 262-290, 311, 330-335, 356; XeTeXLayoutInterface.cpp:117-120; XeTeX_ext.c:161, 225), so that
 * XeTeX compiles unchanged against this header and links against libfontconfig.a built from ../fontlist.c.
 *
 * What it does instead of fontconfig: FcInit reads one list of font faces, written by liveMd2Tex's data builder
 * (scripts/lib/font-list.mjs), and FcFontList returns every face of that list in its order. XeTeX does
 * the matching itself; fontconfig's own matching was never used.
 *
 * FC_VERSION is 0 on purpose: the banner line "Compiled with fontconfig version 0.0.0; using 0.0.0" then says that
 * no fontconfig is linked, without a patch to XeTeX (its buffer, XeTeX_ext.c:183-196, counts the digits).
 */
#ifndef LIVEMD2TEX_FONTCONFIG_H
#define LIVEMD2TEX_FONTCONFIG_H

#ifdef __cplusplus
extern "C" {
#endif

#define FC_VERSION 0

#define FC_FAMILY "family"
#define FC_STYLE "style"
#define FC_FILE "file"
#define FC_INDEX "index"
#define FC_FULLNAME "fullname"
#define FC_WEIGHT "weight"
#define FC_WIDTH "width"
#define FC_SLANT "slant"
#define FC_FONTFORMAT "fontformat"
#define FC_POSTSCRIPT_NAME "postscriptname"

typedef unsigned char FcChar8;
typedef int FcBool;

#define FcFalse 0
#define FcTrue 1

typedef enum _FcResult {
    FcResultMatch,
    FcResultNoMatch,
    FcResultTypeMismatch,
    FcResultNoId,
    FcResultOutOfMemory
} FcResult;

typedef struct _FcPattern FcPattern;
typedef struct _FcConfig FcConfig;
typedef struct _FcObjectSet FcObjectSet;

typedef struct _FcFontSet {
    int nfont;
    int sfont;
    FcPattern **fonts;
} FcFontSet;

FcBool FcInit(void);
int FcGetVersion(void);
FcConfig *FcConfigGetCurrent(void);
FcPattern *FcNameParse(const FcChar8 *name);
FcObjectSet *FcObjectSetBuild(const char *first, ...);
void FcObjectSetDestroy(FcObjectSet *os);
FcFontSet *FcFontList(FcConfig *config, FcPattern *p, FcObjectSet *os);
FcResult FcPatternGetString(const FcPattern *p, const char *object, int n, FcChar8 **s);
FcResult FcPatternGetInteger(const FcPattern *p, const char *object, int n, int *i);
void FcPatternDestroy(FcPattern *p);

#ifdef __cplusplus
}
#endif

#endif /* LIVEMD2TEX_FONTCONFIG_H */
