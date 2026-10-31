/* fontlist.c: liveMd2Tex's stand-in for the ten fontconfig functions XeTeX calls (fontconfig/fontconfig.h says
 * which, and where XeTeX calls them).
 *
 * Ours (the liveMd2Tex authors), GPL-3.0-or-later. Not copied from fontconfig.
 *
 * FcInit reads the font list named by the environment variable LIVEMD2TEX_FONT_LIST (the host writes
 * /engine/fonts.list from the mounted images' fonts/xetex-fonts.tsv). One
 * line per face, UTF-8, nine tab-separated fields:
 *
 *   file path, face index, family names, style names, full names, PostScript name, weight, width, slant
 *
 * Several names in one field are separated by the byte 0x1F. An empty weight, width or slant means "not known"
 * (FcPatternGetInteger then answers FcResultNoMatch, as fontconfig does for a pattern without the value). A line
 * that starts with '#' or has fewer than nine fields is skipped. With no variable, no file or an empty file the
 * list is empty and FcInit still answers FcTrue: XeTeX exits with code 9 when FcInit fails
 * (XeTeXFontMgr_FC.cpp:311-314), and -ini runs and the data builder have no list.
 *
 * FcFontList returns every face in the file's order. XeTeX keeps the first face it meets for a PostScript name, a
 * full name or a family-plus-style pair (XeTeXFontMgr.cpp:569-570, 621-627, 631-634), so the data builder fixes
 * that order. The collision report is on request only: with LIVEMD2TEX_FONT_LIST_CHECK set to a non-empty value,
 * FcInit writes every such collision to stderr ("fonts.list: postscript name ... lines A and B"). The data builder
 * and the font check set the variable; the engine host never does, so users' transcripts never carry the report,
 * which a user could not act on. The builder
 * itself checks the collisions across the sets that are mounted together, in the host's order, and fails on one
 * that crosses sets, since no rule of one set can decide it.
 *
 * Memory: everything is allocated once, on the first FcInit of a program run. The engine host clears the
 * WebAssembly memory and restores its first 64 MiB after each run (BusyTeX's one-instance pattern), which also
 * resets the static state below to "not loaded".
 */
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "fontconfig/fontconfig.h"

enum { NAME_FAMILY, NAME_STYLE, NAME_FULL, NAME_POSTSCRIPT, NAME_KINDS };
enum { INT_WEIGHT, INT_WIDTH, INT_SLANT, INT_KINDS };

struct _FcPattern {
    const char *file;
    int index;
    const char **names[NAME_KINDS];
    int count[NAME_KINDS];
    int value[INT_KINDS];
    unsigned char known[INT_KINDS];
    unsigned char from_list;
    int line;
};

struct _FcConfig {
    int unused;
};

struct _FcObjectSet {
    int unused;
};

static struct _FcConfig the_config;
static struct _FcObjectSet the_object_set;
static FcFontSet the_set;
static int loaded;

static char *read_file(const char *path, size_t *length)
{
    FILE *f = fopen(path, "rb");
    if (f == NULL)
        return NULL;
    size_t size = 0, cap = 65536;
    char *data = malloc(cap + 1);
    if (data == NULL) {
        fclose(f);
        return NULL;
    }
    for (;;) {
        if (size == cap) {
            char *more = realloc(data, 2 * cap + 1);
            if (more == NULL) {
                free(data);
                fclose(f);
                return NULL;
            }
            data = more;
            cap *= 2;
        }
        size_t got = fread(data + size, 1, cap - size, f);
        if (got == 0)
            break;
        size += got;
    }
    fclose(f);
    data[size] = '\0';
    *length = size;
    return data;
}

/* Splits a 0x1F-separated field in place into a NULL-free array of names; an empty field gives none. */
static void split_names(char *field, const char ***names, int *count)
{
    *names = NULL;
    *count = 0;
    if (*field == '\0')
        return;
    int n = 1;
    for (const char *c = field; *c; c++)
        if (*c == '\x1f')
            n++;
    const char **list = malloc(sizeof(char *) * (size_t)n);
    if (list == NULL)
        return;
    int i = 0;
    list[i++] = field;
    for (char *c = field; *c; c++)
        if (*c == '\x1f') {
            *c = '\0';
            list[i++] = c + 1;
        }
    *names = list;
    *count = n;
}

static void set_int(FcPattern *p, int kind, const char *field)
{
    if (*field == '\0')
        return;
    char *end;
    long v = strtol(field, &end, 10);
    if (*end != '\0')
        return;
    p->value[kind] = (int)v;
    p->known[kind] = 1;
}

/* Reads one line (already cut at its end); returns 1 if it gave a face. */
static int parse_line(char *line, int number, FcPattern *p)
{
    char *field[9];
    int n = 0;
    size_t len = strlen(line);
    if (len > 0 && line[len - 1] == '\r')
        line[len - 1] = '\0';
    if (line[0] == '#' || line[0] == '\0')
        return 0;
    field[n++] = line;
    for (char *c = line; *c && n < 9; c++)
        if (*c == '\t') {
            *c = '\0';
            field[n++] = c + 1;
        }
    if (n < 9)
        return 0;
    for (char *c = field[8]; *c; c++)
        if (*c == '\t')
            *c = '\0'; /* extra fields at the end are ignored */
    char *end;
    long index = strtol(field[1], &end, 10);
    if (field[0][0] == '\0' || field[1][0] == '\0' || *end != '\0')
        return 0;
    memset(p, 0, sizeof *p);
    p->file = field[0];
    p->index = (int)index;
    split_names(field[2], &p->names[NAME_FAMILY], &p->count[NAME_FAMILY]);
    split_names(field[3], &p->names[NAME_STYLE], &p->count[NAME_STYLE]);
    split_names(field[4], &p->names[NAME_FULL], &p->count[NAME_FULL]);
    split_names(field[5], &p->names[NAME_POSTSCRIPT], &p->count[NAME_POSTSCRIPT]);
    set_int(p, INT_WEIGHT, field[6]);
    set_int(p, INT_WIDTH, field[7]);
    set_int(p, INT_SLANT, field[8]);
    p->from_list = 1;
    p->line = number;
    return 1;
}

struct key {
    char *text;
    int line;
};

static int compare_keys(const void *a, const void *b)
{
    const struct key *x = a, *y = b;
    int c = strcmp(x->text, y->text);
    return c != 0 ? c : (x->line > y->line) - (x->line < y->line);
}

/* Writes every pair of faces that share a key to stderr; keys are freed. */
static void report_collisions(const char *what, struct key *keys, int n)
{
    qsort(keys, (size_t)n, sizeof *keys, compare_keys);
    for (int i = 1; i < n; i++)
        if (strcmp(keys[i - 1].text, keys[i].text) == 0 && keys[i - 1].line != keys[i].line)
            fprintf(stderr, "fonts.list: %s \"%s\" on lines %d and %d; the first is used\n", what, keys[i].text,
                    keys[i - 1].line, keys[i].line);
    for (int i = 0; i < n; i++)
        free(keys[i].text);
    free(keys);
}

static char *joined(const char *a, const char *b)
{
    size_t la = strlen(a), lb = strlen(b);
    char *s = malloc(la + lb + 2);
    if (s == NULL)
        return NULL;
    memcpy(s, a, la);
    s[la] = ' ';
    memcpy(s + la + 1, b, lb + 1);
    return s;
}

static void check_collisions(void)
{
    static const char *what[] = {"family", "style", "full name", "postscript name"};
    for (int kind = NAME_FULL; kind <= NAME_POSTSCRIPT; kind++) {
        int n = 0;
        for (int f = 0; f < the_set.nfont; f++)
            n += the_set.fonts[f]->count[kind];
        struct key *keys = malloc(sizeof *keys * (size_t)(n ? n : 1));
        if (keys == NULL)
            return;
        int k = 0;
        for (int f = 0; f < the_set.nfont; f++) {
            FcPattern *p = the_set.fonts[f];
            for (int i = 0; i < p->count[kind]; i++) {
                keys[k].text = strdup(p->names[kind][i]);
                keys[k].line = p->line;
                if (keys[k].text != NULL)
                    k++;
            }
        }
        report_collisions(what[kind], keys, k);
    }
    int n = 0;
    for (int f = 0; f < the_set.nfont; f++)
        n += the_set.fonts[f]->count[NAME_FAMILY] * the_set.fonts[f]->count[NAME_STYLE];
    struct key *keys = malloc(sizeof *keys * (size_t)(n ? n : 1));
    if (keys == NULL)
        return;
    int k = 0;
    for (int f = 0; f < the_set.nfont; f++) {
        FcPattern *p = the_set.fonts[f];
        for (int i = 0; i < p->count[NAME_FAMILY]; i++)
            for (int j = 0; j < p->count[NAME_STYLE]; j++) {
                keys[k].text = joined(p->names[NAME_FAMILY][i], p->names[NAME_STYLE][j]);
                keys[k].line = p->line;
                if (keys[k].text != NULL)
                    k++;
            }
    }
    report_collisions("family and style", keys, k);
}

static void load(void)
{
    if (loaded)
        return;
    loaded = 1;
    the_set.nfont = 0;
    the_set.sfont = 0;
    the_set.fonts = NULL;
    const char *path = getenv("LIVEMD2TEX_FONT_LIST");
    if (path == NULL || *path == '\0')
        return;
    size_t length = 0;
    char *data = read_file(path, &length);
    if (data == NULL)
        return;
    int lines = 1;
    for (size_t i = 0; i < length; i++)
        if (data[i] == '\n')
            lines++;
    FcPattern *patterns = malloc(sizeof(FcPattern) * (size_t)lines);
    FcPattern **fonts = malloc(sizeof(FcPattern *) * (size_t)lines);
    if (patterns == NULL || fonts == NULL) {
        free(patterns);
        free(fonts);
        free(data);
        return;
    }
    int n = 0, number = 0;
    char *line = data;
    while (line != NULL && line < data + length) {
        char *next = strchr(line, '\n');
        if (next != NULL)
            *next++ = '\0';
        number++;
        if (parse_line(line, number, &patterns[n])) {
            fonts[n] = &patterns[n];
            n++;
        }
        line = next;
    }
    the_set.nfont = n;
    the_set.sfont = lines;
    the_set.fonts = fonts;
    const char *check = getenv("LIVEMD2TEX_FONT_LIST_CHECK");
    if (check != NULL && *check != '\0')
        check_collisions();
}

FcBool FcInit(void)
{
    load();
    return FcTrue;
}

int FcGetVersion(void)
{
    return FC_VERSION;
}

FcConfig *FcConfigGetCurrent(void)
{
    return &the_config;
}

FcPattern *FcNameParse(const FcChar8 *name)
{
    (void)name; /* XeTeX asks ":outline=true"; every face of the list is an outline font */
    return calloc(1, sizeof(FcPattern));
}

FcObjectSet *FcObjectSetBuild(const char *first, ...)
{
    va_list ap;
    va_start(ap, first);
    for (const char *o = first; o != NULL; o = va_arg(ap, const char *))
        ;
    va_end(ap);
    return &the_object_set;
}

void FcObjectSetDestroy(FcObjectSet *os)
{
    (void)os;
}

FcFontSet *FcFontList(FcConfig *config, FcPattern *p, FcObjectSet *os)
{
    (void)config;
    (void)p;
    (void)os;
    load();
    return &the_set;
}

static int name_kind(const char *object)
{
    if (strcmp(object, FC_FAMILY) == 0)
        return NAME_FAMILY;
    if (strcmp(object, FC_STYLE) == 0)
        return NAME_STYLE;
    if (strcmp(object, FC_FULLNAME) == 0)
        return NAME_FULL;
    if (strcmp(object, FC_POSTSCRIPT_NAME) == 0)
        return NAME_POSTSCRIPT;
    return -1;
}

FcResult FcPatternGetString(const FcPattern *p, const char *object, int n, FcChar8 **s)
{
    if (p == NULL || object == NULL || !p->from_list)
        return FcResultNoMatch;
    if (strcmp(object, FC_FILE) == 0) {
        if (n != 0)
            return FcResultNoId;
        *s = (FcChar8 *)p->file;
        return FcResultMatch;
    }
    int kind = name_kind(object);
    if (kind < 0 || p->count[kind] == 0)
        return FcResultNoMatch;
    if (n < 0 || n >= p->count[kind])
        return FcResultNoId;
    *s = (FcChar8 *)p->names[kind][n];
    return FcResultMatch;
}

FcResult FcPatternGetInteger(const FcPattern *p, const char *object, int n, int *i)
{
    if (p == NULL || object == NULL || !p->from_list)
        return FcResultNoMatch;
    int kind;
    if (strcmp(object, FC_INDEX) == 0) {
        if (n != 0)
            return FcResultNoId;
        *i = p->index;
        return FcResultMatch;
    }
    if (strcmp(object, FC_WEIGHT) == 0)
        kind = INT_WEIGHT;
    else if (strcmp(object, FC_WIDTH) == 0)
        kind = INT_WIDTH;
    else if (strcmp(object, FC_SLANT) == 0)
        kind = INT_SLANT;
    else
        return FcResultNoMatch;
    if (!p->known[kind])
        return FcResultNoMatch;
    if (n != 0)
        return FcResultNoId;
    *i = p->value[kind];
    return FcResultMatch;
}

void FcPatternDestroy(FcPattern *p)
{
    if (p != NULL && !p->from_list)
        free(p); /* only FcNameParse's patterns; the list's faces live for the whole run */
}
