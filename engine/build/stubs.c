/* stubs.c: functions of liveMd2Tex's TeX engine that must never start a program, a shell or a pipe.
 *
 * Ours (the liveMd2Tex authors), GPL-3.0-or-later.
 *
 * Emscripten 6.0.13's libc system() calls _emscripten_system (system/lib/libc/system.c:7-10), which under Node
 * runs the command through child_process.spawnSync with a shell (src/lib/libcore.js:373-382). TeX links system()
 * for \write18, kpathsea uses fork/execvp for mktex* (tex-make.c:319-374), and dvipdfmx for its filters
 * (dpxfile.c:318-322). Because this object file defines each name below, the linker never takes Emscripten's
 * version, and the glue gets no _emscripten_system. Each one fails with ENOSYS. popen is a weak stub in
 * Emscripten's libc (emscripten_libc_stubs.c:199); this strong one wins.
 *
 * getpass answers an empty password: dvipdfmx asks for one for an encrypted PDF and stops asking on an empty
 * answer (dvipdfmx.c:380-389). Emscripten's libc has no getpass.
 */
#include <errno.h>
#include <spawn.h>
#include <stdio.h>
#include <sys/types.h>
#include <unistd.h>

int system(const char *command)
{
    (void)command;
    errno = ENOSYS;
    return -1;
}

FILE *popen(const char *command, const char *mode)
{
    (void)command;
    (void)mode;
    errno = ENOSYS;
    return NULL;
}

int pclose(FILE *stream)
{
    (void)stream;
    errno = ENOSYS;
    return -1;
}

pid_t fork(void)
{
    errno = ENOSYS;
    return -1;
}

pid_t vfork(void)
{
    errno = ENOSYS;
    return -1;
}

int execv(const char *path, char *const argv[])
{
    (void)path;
    (void)argv;
    errno = ENOSYS;
    return -1;
}

int execve(const char *path, char *const argv[], char *const envp[])
{
    (void)path;
    (void)argv;
    (void)envp;
    errno = ENOSYS;
    return -1;
}

int execvp(const char *file, char *const argv[])
{
    (void)file;
    (void)argv;
    errno = ENOSYS;
    return -1;
}

int execl(const char *path, const char *arg, ...)
{
    (void)path;
    (void)arg;
    errno = ENOSYS;
    return -1;
}

int execlp(const char *file, const char *arg, ...)
{
    (void)file;
    (void)arg;
    errno = ENOSYS;
    return -1;
}

int posix_spawn(pid_t *pid, const char *path, const posix_spawn_file_actions_t *actions,
                const posix_spawnattr_t *attr, char *const argv[], char *const envp[])
{
    (void)pid;
    (void)path;
    (void)actions;
    (void)attr;
    (void)argv;
    (void)envp;
    return ENOSYS;
}

int posix_spawnp(pid_t *pid, const char *file, const posix_spawn_file_actions_t *actions,
                 const posix_spawnattr_t *attr, char *const argv[], char *const envp[])
{
    (void)pid;
    (void)file;
    (void)actions;
    (void)attr;
    (void)argv;
    (void)envp;
    return ENOSYS;
}

char *getpass(const char *prompt)
{
    static char empty[1];
    (void)prompt;
    empty[0] = '\0';
    return empty;
}
