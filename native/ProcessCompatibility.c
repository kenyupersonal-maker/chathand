// Signed, short-lived compatibility entrypoint. Never searches PATH or forks.
// The target is fixed at build time and lives next to this executable.
#include <mach-o/dyld.h>
#include <sys/stat.h>
#include <unistd.h>
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifndef CHATHAND_PROCESS_TARGET
#error CHATHAND_PROCESS_TARGET must name a sibling executable
#endif
int main(int argc, char **argv) {
    (void)argc;
    char source[PATH_MAX], resolved[PATH_MAX], target[PATH_MAX];
    uint32_t size = sizeof(source);
    const char *name = CHATHAND_PROCESS_TARGET;
    if (!*name || strchr(name, '/') || !strcmp(name, ".") || !strcmp(name, "..")) return 126;
    if (_NSGetExecutablePath(source, &size) || !realpath(source, resolved)) return 126;
    char *slash = strrchr(resolved, '/');
    if (!slash) return 126;
    *slash = '\0';
    if (snprintf(target, sizeof(target), "%s/%s", resolved, name) >= (int)sizeof(target)) return 126;
    struct stat st;
    if (lstat(target, &st) || !S_ISREG(st.st_mode)) return 126;
    // argv, environment, descriptors, PID, signals and final exit status survive exec.
    execv(target, argv);
    return errno == ENOENT ? 127 : 126;
}
