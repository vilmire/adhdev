/* Pinned host guardian: no PID signalling, no automatic stale-file deletion. */
#include <sys/file.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#ifdef __APPLE__
#include <libproc.h>
#include <sys/sysctl.h>
#include <sys/time.h>
#endif
/* Physical observations only: without retained roots from the original boot,
   even an entirely readable current OS snapshot cannot establish attribution. */
static int recovery_census(void) {
  unsigned long processes = 0, descriptors = 0, unreadable = 0;
  long boot_seconds = 0;
#ifdef __APPLE__
  int bytes = proc_listpids(PROC_ALL_PIDS, 0, NULL, 0);
  if (bytes <= 0 || bytes > 4 * 1024 * 1024) unreadable++;
  else {
    int capacity = bytes + 4096;
    pid_t *pids = calloc(1, (size_t)capacity);
    if (!pids) unreadable++;
    else {
      int got = proc_listpids(PROC_ALL_PIDS, 0, pids, capacity);
      if (got <= 0 || got >= capacity) unreadable++;
      else for (int i = 0; i < got / (int)sizeof(pid_t); i++) {
        pid_t pid = pids[i];
        if (pid <= 0) continue;
        struct proc_bsdinfo before, after;
        if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &before, sizeof(before)) != (int)sizeof(before) ||
            !before.pbi_start_tvsec || before.pbi_pid != (unsigned)pid) { unreadable++; continue; }
        processes++;
        int fd_bytes = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, NULL, 0);
        if (fd_bytes < 0 || fd_bytes > 1024 * 1024) { unreadable++; continue; }
        if (fd_bytes) {
          struct proc_fdinfo *fds = calloc(1, (size_t)fd_bytes);
          if (!fds) { unreadable++; continue; }
          int observed = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, fds, fd_bytes);
          if (observed < 0 || observed > fd_bytes) unreadable++;
          else for (int j = 0; j < observed / (int)sizeof(struct proc_fdinfo); j++) {
            descriptors++;
            if (fds[j].proc_fdtype == PROX_FDTYPE_VNODE) {
              struct vnode_fdinfowithpath vnode;
              if (proc_pidfdinfo(pid, fds[j].proc_fd, PROC_PIDFDVNODEPATHINFO, &vnode, sizeof(vnode)) != (int)sizeof(vnode)) unreadable++;
            }
          }
          free(fds);
        }
        /* Birth/parent continuity across this observation is necessary, never
           sufficient for the historical descendant attribution we lack. */
        if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &after, sizeof(after)) != (int)sizeof(after) ||
            before.pbi_start_tvsec != after.pbi_start_tvsec || before.pbi_start_tvusec != after.pbi_start_tvusec ||
            before.pbi_ppid != after.pbi_ppid) unreadable++;
      }
      free(pids);
    }
  }
  struct timeval boot;
  size_t len = sizeof(boot);
  int mib[2] = { CTL_KERN, KERN_BOOTTIME };
  if (sysctl(mib, 2, &boot, &len, NULL, 0) || len != sizeof(boot)) unreadable++;
  else boot_seconds = boot.tv_sec;
#else
  unreadable++;
#endif
  printf("{\"protocol\":2,\"verdict\":\"UNKNOWN\",\"reason\":\"historical_native_attribution_unavailable\","
         "\"nativeBootSeconds\":%ld,\"processCount\":%lu,\"descriptorCount\":%lu,\"unreadable\":%lu}\n",
         boot_seconds, processes, descriptors, unreadable);
  return 0;
}
int main(int argc, char **argv) {
  if (argc != 2) return 64;
  if (!strcmp(argv[1], "--attest")) { puts("adhdev-host-guardian/2"); return 0; }
  /* flock proves current exclusion only. In particular it has no retained
     process-birth, descendant or transcript-handle attribution for old boots. */
  if (!strcmp(argv[1], "--recovery-coverage-v1")) {
    puts("{\"protocol\":1,\"verdict\":\"UNKNOWN\",\"reason\":\"historical_native_attribution_unavailable\"}");
    return 0;
  }
  if (!strcmp(argv[1], "--recovery-native-census-v2")) return recovery_census();
  if (argv[1][0] == '-') return 64;
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
