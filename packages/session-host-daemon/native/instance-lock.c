/* Pinned host guardian: no PID signalling, no automatic stale-file deletion. */
#include <sys/file.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdio.h>
#include <string.h>
int main(int argc, char **argv) {
  if (argc != 2) return 64;
  if (!strcmp(argv[1], "--attest")) { puts("adhdev-host-guardian/1"); return 0; }
  int fd = open(argv[1], O_CREAT | O_RDWR | O_NOFOLLOW, 0600);
  struct stat st;
  if (fd < 0 || fstat(fd, &st) || !S_ISREG(st.st_mode) || st.st_uid != getuid() ||
      st.st_nlink != 1 || (st.st_mode & 077) || flock(fd, LOCK_EX | LOCK_NB)) return 73;
  puts("LOCKED"); fflush(stdout);
  /* EOF follows parent death; the kernel releases flock. Never unlink its inode. */
  char byte;
  while (read(STDIN_FILENO, &byte, 1) > 0) {}
  close(fd);
  return 0;
}
