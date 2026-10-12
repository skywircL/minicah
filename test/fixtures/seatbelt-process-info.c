/* Test-only probe. The harness supplies only the PID of its own fake-secret fixture.
 * Never prints process arguments, environment contents, or the test secret value. */
#include <sys/types.h>
#include <sys/sysctl.h>
#include <sys/wait.h>
#include <spawn.h>
#include <unistd.h>
#include <stdlib.h>
#include <stdio.h>
#include <errno.h>
#include <string.h>

extern char **environ;

static int contains(const char *buffer, size_t length, const char *text) {
  size_t text_length = strlen(text);
  for (size_t i = 0; i + text_length <= length; i++) {
    if (!memcmp(buffer + i, text, text_length)) return 1;
  }
  return 0;
}

static int procargs(int argc, char **argv) {
  if (argc < 3) return 2;
  int target = atoi(argv[2]);
  if (target <= 1 || target == getpid()) return 3;
  int mib[3] = {CTL_KERN, KERN_PROCARGS2, target};
  size_t length = 256 * 1024;
  char *buffer = calloc(1, length);
  if (!buffer) return 4;
  int result = sysctl(mib, 3, buffer, &length, NULL, 0), saved_errno = errno;
  printf("{\"readSucceeded\":%s,\"fixtureExecutableMatches\":%s,\"fixtureSecretReadable\":%s,\"samePidAfterExec\":%s,\"errno\":%d}\n",
    result == 0 ? "true" : "false",
    result == 0 && contains(buffer, length, "/process-probe") ? "true" : "false",
    result == 0 && contains(buffer, length, "SANDBOX_TEST_SECRET=fake-minicah-fixture-only") ? "true" : "false",
    argc == 4 && atoi(argv[3]) == getpid() ? "true" : "false",
    result == 0 ? 0 : saved_errno);
  free(buffer);
  return 0;
}

int main(int argc, char **argv) {
  if (argc < 2) return 2;
  if (!strcmp(argv[1], "fixture")) { sleep(30); return 0; }
  if (!strcmp(argv[1], "procargs")) return procargs(argc, argv);
  if (!strcmp(argv[1], "fork")) {
    errno = 0;
    pid_t child = fork();
    int saved_errno = errno;
    if (child == 0) _exit(0);
    if (child > 0) waitpid(child, NULL, 0);
    printf("{\"denied\":%s,\"errno\":%d}\n", child == -1 ? "true" : "false", child == -1 ? saved_errno : 0);
    return 0;
  }
  if (!strcmp(argv[1], "spawn")) {
    char *arguments[] = {"/bin/echo", "unexpected-child", NULL};
    pid_t child = -1;
    int result = posix_spawn(&child, arguments[0], NULL, NULL, arguments, environ);
    if (!result) waitpid(child, NULL, 0);
    printf("{\"denied\":%s,\"errno\":%d}\n", result ? "true" : "false", result);
    return 0;
  }
  if ((!strcmp(argv[1], "exec") || !strcmp(argv[1], "setexec")) && argc == 3) {
    char expected_pid[32];
    snprintf(expected_pid, sizeof(expected_pid), "%d", getpid());
    char *arguments[] = {argv[0], "procargs", argv[2], expected_pid, NULL};
    if (!strcmp(argv[1], "exec")) execve(arguments[0], arguments, environ);
    else {
      posix_spawnattr_t attributes;
      posix_spawnattr_init(&attributes);
      posix_spawnattr_setflags(&attributes, POSIX_SPAWN_SETEXEC);
      pid_t ignored;
      int result = posix_spawn(&ignored, arguments[0], NULL, &attributes, arguments, environ);
      posix_spawnattr_destroy(&attributes);
      errno = result;
    }
    return 5; /* A successful exec never returns. */
  }
  return 2;
}
