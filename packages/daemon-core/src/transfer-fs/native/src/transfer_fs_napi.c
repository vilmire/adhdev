#define NAPI_VERSION 8
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#ifndef _DARWIN_C_SOURCE
#define _DARWIN_C_SOURCE
#endif

#include <node_api.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifndef ADHDEV_TRANSFER_FS_API_LEVEL
#define ADHDEV_TRANSFER_FS_API_LEVEL 1
#endif
#ifndef ADHDEV_TRANSFER_FS_SOURCE_DIGEST
#define ADHDEV_TRANSFER_FS_SOURCE_DIGEST "unknown"
#endif
#ifndef ADHDEV_TRANSFER_FS_C_COMPILER
#define ADHDEV_TRANSFER_FS_C_COMPILER "unknown"
#endif
#ifndef ADHDEV_TRANSFER_FS_BUILD_TYPE
#define ADHDEV_TRANSFER_FS_BUILD_TYPE "Release"
#endif

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winternl.h>
#include <wchar.h>

#ifndef FILE_OPEN_REPARSE_POINT
#define FILE_OPEN_REPARSE_POINT 0x00200000
#endif
#ifndef FILE_SYNCHRONOUS_IO_NONALERT
#define FILE_SYNCHRONOUS_IO_NONALERT 0x00000020
#endif
#ifndef FILE_DIRECTORY_FILE
#define FILE_DIRECTORY_FILE 0x00000001
#endif
#ifndef FILE_NON_DIRECTORY_FILE
#define FILE_NON_DIRECTORY_FILE 0x00000040
#endif
#ifndef FILE_CREATE
#define FILE_CREATE 0x00000002
#endif
#ifndef FILE_OPEN
#define FILE_OPEN 0x00000001
#endif
#ifndef OBJ_CASE_INSENSITIVE
#define OBJ_CASE_INSENSITIVE 0x00000040L
#endif
#ifndef STATUS_INVALID_INFO_CLASS
#define STATUS_INVALID_INFO_CLASS ((NTSTATUS)0xC0000003L)
#endif
#ifndef STATUS_NOT_SUPPORTED
#define STATUS_NOT_SUPPORTED ((NTSTATUS)0xC00000BBL)
#endif

typedef NTSTATUS(NTAPI *NtCreateFile_t)(
    PHANDLE FileHandle,
    ACCESS_MASK DesiredAccess,
    POBJECT_ATTRIBUTES ObjectAttributes,
    PIO_STATUS_BLOCK IoStatusBlock,
    PLARGE_INTEGER AllocationSize,
    ULONG FileAttributes,
    ULONG ShareAccess,
    ULONG CreateDisposition,
    ULONG CreateOptions,
    PVOID EaBuffer,
    ULONG EaLength);

typedef NTSTATUS(NTAPI *NtSetInformationFile_t)(
    HANDLE FileHandle,
    PIO_STATUS_BLOCK IoStatusBlock,
    PVOID FileInformation,
    ULONG Length,
    ULONG FileInformationClass);

typedef NTSTATUS(NTAPI *NtQueryInformationFile_t)(
    HANDLE FileHandle,
    PIO_STATUS_BLOCK IoStatusBlock,
    PVOID FileInformation,
    ULONG Length,
    ULONG FileInformationClass);

typedef ULONG(NTAPI *RtlNtStatusToDosError_t)(NTSTATUS Status);

typedef struct _ADHDEV_FILE_RENAME_INFO_EX {
  union {
    BOOLEAN ReplaceIfExists;
    ULONG Flags;
  };
  HANDLE RootDirectory;
  ULONG FileNameLength;
  WCHAR FileName[1];
} ADHDEV_FILE_RENAME_INFO_EX;

typedef struct _ADHDEV_FILE_CASE_SENSITIVE_INFO {
  ULONG Flags;
} ADHDEV_FILE_CASE_SENSITIVE_INFO;

static NtCreateFile_t pNtCreateFile = NULL;
static NtSetInformationFile_t pNtSetInformationFile = NULL;
static NtQueryInformationFile_t pNtQueryInformationFile = NULL;
static RtlNtStatusToDosError_t pRtlNtStatusToDosError = NULL;
static INIT_ONCE g_ntdll_init_once = INIT_ONCE_STATIC_INIT;

static BOOL CALLBACK init_ntdll_cb(PINIT_ONCE once, PVOID param, PVOID *ctx) {
  (void)once;
  (void)param;
  (void)ctx;
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  if (!ntdll) return FALSE;
  pNtCreateFile = (NtCreateFile_t)GetProcAddress(ntdll, "NtCreateFile");
  pNtSetInformationFile = (NtSetInformationFile_t)GetProcAddress(ntdll, "NtSetInformationFile");
  pNtQueryInformationFile = (NtQueryInformationFile_t)GetProcAddress(ntdll, "NtQueryInformationFile");
  pRtlNtStatusToDosError = (RtlNtStatusToDosError_t)GetProcAddress(ntdll, "RtlNtStatusToDosError");
  return (pNtCreateFile && pNtSetInformationFile && pRtlNtStatusToDosError) ? TRUE : FALSE;
}

static void ensure_ntdll(void) {
  InitOnceExecuteOnce(&g_ntdll_init_once, init_ntdll_cb, NULL, NULL);
}

#else /* POSIX */
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <strings.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
#if defined(__APPLE__)
#include <stdio.h>
#include <sys/attr.h>
#include <sys/mount.h>
#include <sys/param.h>
#ifndef RENAME_EXCL
#define RENAME_EXCL 0x00000004
#endif
#elif defined(__linux__)
#include <sys/statfs.h>
#include <sys/syscall.h>
#ifndef RENAME_NOREPLACE
#define RENAME_NOREPLACE (1U << 0)
#endif
#ifndef O_PATH
#define O_PATH 010000000
#endif
#endif
#endif

/* -------------------------------------------------------------------------
 * Generation-guarded handle table
 * ------------------------------------------------------------------------- */
#define MAX_HANDLES 4096

typedef struct {
  bool active;
  bool is_dir;
  bool is_root;
  uint32_t generation;
#ifdef _WIN32
  HANDLE h;
#else
  int fd;
  int parent_slot;
  uint32_t parent_gen;
  char name[256];
  uint64_t dev;
  uint64_t ino;
#endif
} handle_slot_t;

static handle_slot_t g_slots[MAX_HANDLES];
static uint32_t g_next_gen = 1;
#ifdef _WIN32
static SRWLOCK g_slot_lock = SRWLOCK_INIT;
#define LOCK_SLOTS() AcquireSRWLockExclusive(&g_slot_lock)
#define UNLOCK_SLOTS() ReleaseSRWLockExclusive(&g_slot_lock)
#else
static pthread_mutex_t g_slot_lock = PTHREAD_MUTEX_INITIALIZER;
#define LOCK_SLOTS() pthread_mutex_lock(&g_slot_lock)
#define UNLOCK_SLOTS() pthread_mutex_unlock(&g_slot_lock)
#endif

typedef enum {
  TEST_FI_NONE = 0,
  TEST_FI_SWAP_SRC_BEFORE_RENAME = 1,
  TEST_FI_REPLACE_DST_AFTER_RENAME = 2,
  TEST_FI_HARDLINK_AFTER_RENAME = 3,
  TEST_FI_ATOMIC_RENAME_ERRNO = 4
} test_fi_mode_t;

typedef struct {
  test_fi_mode_t mode;
  int injected_errno;
  char aux_name[256];
} test_fi_config_t;

static test_fi_config_t g_test_fi = {TEST_FI_NONE, 0, {0}};

static int64_t make_token(int slot, uint32_t gen) {
  return ((int64_t)gen << 16) | (int64_t)(slot & 0xFFFF);
}

static bool parse_token(int64_t token, int *out_slot, uint32_t *out_gen) {
  if (token <= 0) return false;
  int slot = (int)(token & 0xFFFF);
  uint32_t gen = (uint32_t)((uint64_t)token >> 16);
  if (slot < 0 || slot >= MAX_HANDLES || gen == 0) return false;
  *out_slot = slot;
  *out_gen = gen;
  return true;
}

#ifdef _WIN32
static int64_t alloc_win_slot(HANDLE h, bool is_dir, bool is_root) {
  LOCK_SLOTS();
  for (int i = 0; i < MAX_HANDLES; i++) {
    if (!g_slots[i].active) {
      uint32_t gen = g_next_gen++;
      if (gen == 0) gen = g_next_gen++;
      g_slots[i].active = true;
      g_slots[i].is_dir = is_dir;
      g_slots[i].is_root = is_root;
      g_slots[i].generation = gen;
      g_slots[i].h = h;
      int64_t tok = make_token(i, gen);
      UNLOCK_SLOTS();
      return tok;
    }
  }
  UNLOCK_SLOTS();
  return -1;
}

static bool lookup_win_slot(int64_t token, HANDLE *out_h, bool *out_is_dir) {
  int slot = 0;
  uint32_t gen = 0;
  if (!parse_token(token, &slot, &gen)) return false;
  LOCK_SLOTS();
  handle_slot_t *s = &g_slots[slot];
  if (!s->active || s->generation != gen) {
    UNLOCK_SLOTS();
    return false;
  }
  if (out_h) *out_h = s->h;
  if (out_is_dir) *out_is_dir = s->is_dir;
  UNLOCK_SLOTS();
  return true;
}
#else
static int64_t alloc_posix_slot(
    int fd,
    bool is_dir,
    bool is_root,
    int parent_slot,
    uint32_t parent_gen,
    const char *name,
    uint64_t dev,
    uint64_t ino) {
  LOCK_SLOTS();
  for (int i = 0; i < MAX_HANDLES; i++) {
    if (!g_slots[i].active) {
      uint32_t gen = g_next_gen++;
      if (gen == 0) gen = g_next_gen++;
      g_slots[i].active = true;
      g_slots[i].is_dir = is_dir;
      g_slots[i].is_root = is_root;
      g_slots[i].generation = gen;
      g_slots[i].fd = fd;
      g_slots[i].parent_slot = parent_slot;
      g_slots[i].parent_gen = parent_gen;
      g_slots[i].dev = dev;
      g_slots[i].ino = ino;
      if (name) {
        strncpy(g_slots[i].name, name, sizeof(g_slots[i].name) - 1);
        g_slots[i].name[sizeof(g_slots[i].name) - 1] = '\0';
      } else {
        g_slots[i].name[0] = '\0';
      }
      int64_t tok = make_token(i, gen);
      UNLOCK_SLOTS();
      return tok;
    }
  }
  UNLOCK_SLOTS();
  return -1;
}

static bool lookup_posix_slot(
    int64_t token,
    int *out_fd,
    bool *out_is_dir,
    int *out_slot,
    uint32_t *out_gen) {
  int slot = 0;
  uint32_t gen = 0;
  if (!parse_token(token, &slot, &gen)) return false;
  LOCK_SLOTS();
  handle_slot_t *s = &g_slots[slot];
  if (!s->active || s->generation != gen) {
    UNLOCK_SLOTS();
    return false;
  }
  if (out_fd) *out_fd = s->fd;
  if (out_is_dir) *out_is_dir = s->is_dir;
  if (out_slot) *out_slot = slot;
  if (out_gen) *out_gen = gen;
  UNLOCK_SLOTS();
  return true;
}
#endif

/* -------------------------------------------------------------------------
 * Portable segment validation (enforced in native code on all platforms)
 * ------------------------------------------------------------------------- */
static char ascii_lower(char c) {
  return (c >= 'A' && c <= 'Z') ? (char)(c + 32) : c;
}

static bool is_reserved_dos_stem_utf8(const char *seg, size_t stem_len) {
  if (stem_len == 3) {
    char c0 = ascii_lower(seg[0]);
    char c1 = ascii_lower(seg[1]);
    char c2 = ascii_lower(seg[2]);
    if (c0 == 'c' && c1 == 'o' && c2 == 'n') return true;
    if (c0 == 'p' && c1 == 'r' && c2 == 'n') return true;
    if (c0 == 'a' && c1 == 'u' && c2 == 'x') return true;
    if (c0 == 'n' && c1 == 'u' && c2 == 'l') return true;
  } else if (stem_len == 4) {
    char c0 = ascii_lower(seg[0]);
    char c1 = ascii_lower(seg[1]);
    char c2 = ascii_lower(seg[2]);
    char c3 = seg[3];
    if (((c0 == 'c' && c1 == 'o' && c2 == 'm') ||
         (c0 == 'l' && c1 == 'p' && c2 == 't')) &&
        (c3 >= '1' && c3 <= '9')) {
      return true;
    }
  } else if (stem_len == 5) {
    /* UTF-8 superscripts U+00B9 (C2 B9), U+00B2 (C2 B2), U+00B3 (C2 B3) */
    char c0 = ascii_lower(seg[0]);
    char c1 = ascii_lower(seg[1]);
    char c2 = ascii_lower(seg[2]);
    unsigned char b3 = (unsigned char)seg[3];
    unsigned char b4 = (unsigned char)seg[4];
    if (((c0 == 'c' && c1 == 'o' && c2 == 'm') ||
         (c0 == 'l' && c1 == 'p' && c2 == 't')) &&
        b3 == 0xC2 && (b4 == 0xB9 || b4 == 0xB2 || b4 == 0xB3)) {
      return true;
    }
  } else if (stem_len == 6) {
    char b[6];
    for (int i = 0; i < 6; i++) b[i] = ascii_lower(seg[i]);
    if (memcmp(b, "conin$", 6) == 0 || memcmp(b, "clock$", 6) == 0) return true;
  } else if (stem_len == 7) {
    char b[7];
    for (int i = 0; i < 7; i++) b[i] = ascii_lower(seg[i]);
    if (memcmp(b, "conout$", 7) == 0) return true;
  }
  return false;
}

static bool validate_segment_utf8(const char *seg, size_t len) {
  if (!seg || len == 0 || len > 255) return false;
  if (len == 1 && seg[0] == '.') return false;
  if (len == 2 && seg[0] == '.' && seg[1] == '.') return false;
  if (seg[len - 1] == '.' || seg[len - 1] == ' ') return false;

  size_t stem_len = len;
  for (size_t i = 0; i < len; i++) {
    unsigned char c = (unsigned char)seg[i];
    if (c < 0x20 || c == 0x7F || c == '/' || c == '\\' || c == ':' || c == '~') {
      return false;
    }
    if (c == '.' && stem_len == len) {
      stem_len = i;
    }
  }
  /* Trim trailing spaces from stem before extension (e.g. "NUL .txt") */
  while (stem_len > 0 && seg[stem_len - 1] == ' ') {
    stem_len--;
  }
  if (is_reserved_dos_stem_utf8(seg, stem_len)) return false;
  return true;
}

#ifdef _WIN32
static bool validate_segment_utf16(const wchar_t *wseg, size_t wlen, const char *utf8_seg, size_t utf8_len) {
  if (!validate_segment_utf8(utf8_seg, utf8_len)) return false;
  if (!wseg || wlen == 0 || wlen > 255) return false;
  for (size_t i = 0; i < wlen; i++) {
    wchar_t wc = wseg[i];
    if (wc < 0x20 || wc == 0x7F || wc == L'/' || wc == L'\\' || wc == L':' || wc == L'~') {
      return false;
    }
    /* Reject unpaired UTF-16 surrogates */
    if (wc >= 0xD800 && wc <= 0xDBFF) {
      if (i + 1 >= wlen || wseg[i + 1] < 0xDC00 || wseg[i + 1] > 0xDFFF) return false;
      i++;
    } else if (wc >= 0xDC00 && wc <= 0xDFFF) {
      return false;
    }
  }
  return true;
}
#endif

/* -------------------------------------------------------------------------
 * N-API value helpers
 * ------------------------------------------------------------------------- */
static bool get_handle_token(napi_env env, napi_value val, int64_t *out_token) {
  napi_valuetype t;
  if (napi_typeof(env, val, &t) != napi_ok) return false;
  if (t == napi_number) {
    if (napi_get_value_int64(env, val, out_token) != napi_ok) return false;
    return true;
  }
  if (t == napi_bigint) {
    bool lossless = false;
    if (napi_get_value_bigint_int64(env, val, out_token, &lossless) != napi_ok) return false;
    return true;
  }
  return false;
}

static napi_value create_handle_value(napi_env env, int64_t token) {
  napi_value out;
  napi_create_int64(env, token, &out);
  return out;
}

static bool get_utf8_arg(napi_env env, napi_value val, char *buf, size_t cap, size_t *out_len) {
  napi_valuetype t;
  if (napi_typeof(env, val, &t) != napi_ok || t != napi_string) return false;
  size_t raw_len = 0;
  if (napi_get_value_string_utf8(env, val, NULL, 0, &raw_len) != napi_ok) return false;
  if (raw_len + 1 > cap) return false;
  size_t copied = 0;
  if (napi_get_value_string_utf8(env, val, buf, cap, &copied) != napi_ok) return false;
  /* Reject embedded NUL bytes inside JS string */
  if (copied != raw_len || strlen(buf) != raw_len) return false;
  if (out_len) *out_len = copied;
  return true;
}

#ifdef _WIN32
static bool get_utf16_arg(napi_env env, napi_value val, wchar_t *wbuf, size_t wcap, size_t *out_wlen) {
  napi_valuetype t;
  if (napi_typeof(env, val, &t) != napi_ok || t != napi_string) return false;
  size_t raw_wlen = 0;
  if (napi_get_value_string_utf16(env, val, NULL, 0, &raw_wlen) != napi_ok) return false;
  if (raw_wlen + 1 > wcap) return false;
  size_t copied = 0;
  if (napi_get_value_string_utf16(env, val, (char16_t *)wbuf, wcap, &copied) != napi_ok) return false;
  wbuf[copied] = 0;
  if (copied != raw_wlen || wcslen(wbuf) != raw_wlen) return false;
  if (out_wlen) *out_wlen = copied;
  return true;
}

static const char *win_err_to_posix_code(DWORD err) {
  switch (err) {
    case ERROR_FILE_EXISTS:
    case ERROR_ALREADY_EXISTS:
      return "EEXIST";
    case ERROR_FILE_NOT_FOUND:
    case ERROR_PATH_NOT_FOUND:
      return "ENOENT";
    case ERROR_CANT_ACCESS_FILE:
    case ERROR_REPARSE_TAG_INVALID:
    case ERROR_REPARSE_TAG_MISMATCH:
      return "ELOOP";
    case ERROR_INVALID_NAME:
    case ERROR_INVALID_PARAMETER:
    case ERROR_BAD_PATHNAME:
    case ERROR_FILENAME_EXCED_RANGE:
      return "EINVAL";
    case ERROR_DIRECTORY:
      return "ENOTDIR";
    case ERROR_DIR_NOT_EMPTY:
      return "ENOTEMPTY";
    case ERROR_DISK_FULL:
    case ERROR_HANDLE_DISK_FULL:
      return "ENOSPC";
    case ERROR_ACCESS_DENIED:
    case ERROR_SHARING_VIOLATION:
    case ERROR_LOCK_VIOLATION:
      return "EACCES";
    case ERROR_INVALID_HANDLE:
      return "EBADF";
    case ERROR_NOT_SAME_DEVICE:
      return "EXDEV";
    case ERROR_NOT_SUPPORTED:
    case ERROR_CALL_NOT_IMPLEMENTED:
    case ERROR_INVALID_FUNCTION:
      return "ATOMIC_NOREPLACE_UNSUPPORTED";
    default:
      return "EIO";
  }
}

static napi_value throw_win_error(napi_env env, const char *op, DWORD err) {
  const char *code = win_err_to_posix_code(err);
  char msg[192];
  snprintf(msg, sizeof(msg), "%s failed (%s / WIN_%lu)", op, code, (unsigned long)err);
  napi_throw_error(env, code, msg);
  return NULL;
}
#else
static bool posix_is_atomic_noreplace_unsupported_errno(int err) {
  if (err == ENOSYS || err == ENOTSUP) return true;
#if defined(EOPNOTSUPP) && EOPNOTSUPP != ENOTSUP
  if (err == EOPNOTSUPP) return true;
#endif
  return false;
}

static const char *errno_to_code(int err) {
  switch (err) {
    case EEXIST: return "EEXIST";
    case ENOENT: return "ENOENT";
    case ELOOP: return "ELOOP";
    case EINVAL: return "EINVAL";
    case ENAMETOOLONG: return "EINVAL";
    case ENOTDIR: return "ENOTDIR";
    case EISDIR: return "EISDIR";
    case ENOTEMPTY: return "ENOTEMPTY";
    case ENOSPC: return "ENOSPC";
    case EDQUOT: return "ENOSPC";
    case EACCES: return "EACCES";
    case EPERM: return "EPERM";
    case EBADF: return "EBADF";
    case EMLINK: return "EMLINK";
    case EXDEV: return "EXDEV";
    case ENOSYS: return "ATOMIC_NOREPLACE_UNSUPPORTED";
    case ENOTSUP: return "ATOMIC_NOREPLACE_UNSUPPORTED";
#if defined(EOPNOTSUPP) && EOPNOTSUPP != ENOTSUP
    case EOPNOTSUPP: return "ATOMIC_NOREPLACE_UNSUPPORTED";
#endif
    default: return "EIO";
  }
}

static napi_value throw_posix_error(napi_env env, const char *op, int err) {
  const char *code = errno_to_code(err);
  char msg[192];
  snprintf(msg, sizeof(msg), "%s failed (%s / errno=%d: %s)", op, code, err, strerror(err));
  napi_throw_error(env, code, msg);
  return NULL;
}
#endif

/* -------------------------------------------------------------------------
 * Windows kernel primitive helpers
 * ------------------------------------------------------------------------- */
#ifdef _WIN32
static const wchar_t *strip_win_extended_prefix(const wchar_t *p) {
  if (wcsncmp(p, L"\\\\?\\", 4) == 0) {
    return p + 4;
  }
  return p;
}

static bool win_path_is_unc_or_device(const wchar_t *wpath) {
  if (!wpath || !wpath[0]) return true;
  if ((wpath[0] == L'\\' && wpath[1] == L'\\') ||
      (wpath[0] == L'/' && wpath[1] == L'/')) {
    /* Allow \\?\X:\... only if X is a drive letter */
    if (wcsncmp(wpath, L"\\\\?\\", 4) == 0) {
      wchar_t d = wpath[4];
      if (((d >= L'A' && d <= L'Z') || (d >= L'a' && d <= L'z')) &&
          wpath[5] == L':' && (wpath[6] == L'\\' || wpath[6] == L'/')) {
        return false;
      }
    }
    return true;
  }
  return false;
}

static bool win_path_has_hostile_syntax(const wchar_t *wpath) {
  const wchar_t *p = strip_win_extended_prefix(wpath);
  /* Expect drive letter C:\... */
  if (!(((p[0] >= L'A' && p[0] <= L'Z') || (p[0] >= L'a' && p[0] <= L'z')) &&
        p[1] == L':' && (p[2] == L'\\' || p[2] == L'/'))) {
    return true;
  }
  /* Scan rest after X:\ for ':', '~', control chars, or trailing dot/space on components */
  const wchar_t *rest = p + 3;
  size_t seg_len = 0;
  wchar_t prev = 0;
  for (size_t i = 0; rest[i] != 0; i++) {
    wchar_t c = rest[i];
    if (c < 0x20 || c == 0x7F || c == L':' || c == L'~') return true;
    if (c == L'\\' || c == L'/') {
      if (seg_len > 0 && (prev == L'.' || prev == L' ')) return true;
      seg_len = 0;
    } else {
      seg_len++;
      prev = c;
    }
  }
  if (seg_len > 0 && (prev == L'.' || prev == L' ')) return true;
  return false;
}

static HANDLE win_open_root_internal(const wchar_t *wpath, DWORD *out_err) {
  if (win_path_is_unc_or_device(wpath) || win_path_has_hostile_syntax(wpath)) {
    *out_err = ERROR_INVALID_NAME;
    return INVALID_HANDLE_VALUE;
  }
  wchar_t full_path[1024];
  DWORD full_len = GetFullPathNameW(wpath, 1024, full_path, NULL);
  if (full_len == 0 || full_len >= 1024) {
    *out_err = ERROR_INVALID_NAME;
    return INVALID_HANDLE_VALUE;
  }
  /* Trim trailing backslash on non-root paths (e.g. C:\foo\ -> C:\foo) */
  const wchar_t *full_stripped = strip_win_extended_prefix(full_path);
  size_t fs_len = wcslen(full_stripped);
  wchar_t norm_full[1024];
  wcscpy_s(norm_full, 1024, full_stripped);
  while (fs_len > 3 && (norm_full[fs_len - 1] == L'\\' || norm_full[fs_len - 1] == L'/')) {
    norm_full[--fs_len] = 0;
  }

  HANDLE h = CreateFileW(
      wpath,
      FILE_LIST_DIRECTORY | FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      FILE_SHARE_READ | FILE_SHARE_WRITE,
      NULL,
      OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
      NULL);
  if (h == INVALID_HANDLE_VALUE) {
    *out_err = GetLastError();
    return INVALID_HANDLE_VALUE;
  }

  FILE_ATTRIBUTE_TAG_INFO tag = {0};
  if (!GetFileInformationByHandleEx(h, FileAttributeTagInfo, &tag, sizeof(tag))) {
    *out_err = GetLastError();
    CloseHandle(h);
    return INVALID_HANDLE_VALUE;
  }
  if ((tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
    CloseHandle(h);
    *out_err = ERROR_CANT_ACCESS_FILE;
    return INVALID_HANDLE_VALUE;
  }
  if ((tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0) {
    CloseHandle(h);
    *out_err = ERROR_DIRECTORY;
    return INVALID_HANDLE_VALUE;
  }

  /* Verify canonical final path matches norm_full so ancestor junctions/symlinks/8.3 aliases are rejected */
  wchar_t final_path[1024];
  DWORD final_len = GetFinalPathNameByHandleW(h, final_path, 1024, VOLUME_NAME_DOS);
  if (final_len == 0 || final_len >= 1024) {
    *out_err = GetLastError();
    CloseHandle(h);
    return INVALID_HANDLE_VALUE;
  }
  const wchar_t *final_stripped = strip_win_extended_prefix(final_path);
  if (CompareStringOrdinal(final_stripped, -1, norm_full, -1, TRUE) != CSTR_EQUAL) {
    CloseHandle(h);
    *out_err = ERROR_CANT_ACCESS_FILE;
    return INVALID_HANDLE_VALUE;
  }

  *out_err = 0;
  return h;
}

static bool win_case_insensitive_target_exists(HANDLE target_dir, const wchar_t *wname, size_t wlen) {
  ensure_ntdll();
  UNICODE_STRING us;
  us.Buffer = (PWSTR)wname;
  us.Length = (USHORT)(wlen * sizeof(WCHAR));
  us.MaximumLength = (USHORT)((wlen + 1) * sizeof(WCHAR));
  OBJECT_ATTRIBUTES oa;
  InitializeObjectAttributes(&oa, &us, OBJ_CASE_INSENSITIVE, target_dir, NULL);
  IO_STATUS_BLOCK io = {0};
  HANDLE probe = NULL;
  NTSTATUS st = pNtCreateFile(
      &probe,
      FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      &oa,
      &io,
      NULL,
      FILE_ATTRIBUTE_NORMAL,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      FILE_OPEN,
      FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
      NULL,
      0);
  if (st >= 0 && probe) {
    CloseHandle(probe);
    return true;
  }
  if (st < 0) {
    DWORD dos = pRtlNtStatusToDosError(st);
    if (dos == ERROR_SHARING_VIOLATION || dos == ERROR_ACCESS_DENIED || dos == ERROR_ALREADY_EXISTS || dos == ERROR_FILE_EXISTS) {
      return true;
    }
  }
  return false;
}

static bool win_is_reparse_point_rel(POBJECT_ATTRIBUTES oa) {
  IO_STATUS_BLOCK io = {0};
  HANDLE probe = NULL;
  NTSTATUS st = pNtCreateFile(
      &probe,
      FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      oa,
      &io,
      NULL,
      FILE_ATTRIBUTE_NORMAL,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      FILE_OPEN,
      FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
      NULL,
      0);
  if (st < 0 || !probe) return false;
  FILE_ATTRIBUTE_TAG_INFO tag = {0};
  bool is_reparse = GetFileInformationByHandleEx(probe, FileAttributeTagInfo, &tag, sizeof(tag)) &&
                    (tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
  CloseHandle(probe);
  return is_reparse;
}

static HANDLE win_open_rel_internal(
    HANDLE parent,
    const wchar_t *wname,
    size_t wlen,
    const char *utf8_name,
    size_t utf8_len,
    bool is_dir,
    bool create_excl,
    bool read_only,
    DWORD *out_err) {
  ensure_ntdll();
  if (!pNtCreateFile || !pRtlNtStatusToDosError) {
    *out_err = ERROR_PROC_NOT_FOUND;
    return NULL;
  }
  if (!validate_segment_utf16(wname, wlen, utf8_name, utf8_len)) {
    *out_err = ERROR_INVALID_NAME;
    return NULL;
  }
  if (create_excl && win_case_insensitive_target_exists(parent, wname, wlen)) {
    *out_err = ERROR_ALREADY_EXISTS;
    return NULL;
  }

  UNICODE_STRING us;
  us.Buffer = (PWSTR)wname;
  us.Length = (USHORT)(wlen * sizeof(WCHAR));
  us.MaximumLength = (USHORT)((wlen + 1) * sizeof(WCHAR));

  OBJECT_ATTRIBUTES oa;
  InitializeObjectAttributes(&oa, &us, OBJ_CASE_INSENSITIVE, parent, NULL);

  IO_STATUS_BLOCK io = {0};
  HANDLE h = NULL;
  ULONG create_opts = FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT |
                      (is_dir ? FILE_DIRECTORY_FILE : FILE_NON_DIRECTORY_FILE);
  ACCESS_MASK access;
  ULONG share_access;
  if (is_dir) {
    access = SYNCHRONIZE | FILE_READ_ATTRIBUTES | DELETE |
             FILE_LIST_DIRECTORY | FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY | FILE_TRAVERSE;
    share_access = FILE_SHARE_READ | FILE_SHARE_WRITE;
  } else if (read_only) {
    access = SYNCHRONIZE | FILE_READ_ATTRIBUTES | GENERIC_READ;
    share_access = FILE_SHARE_READ;
  } else {
    access = SYNCHRONIZE | FILE_READ_ATTRIBUTES | DELETE | GENERIC_READ | GENERIC_WRITE;
    share_access = 0; /* Exclusive lock while staging */
  }

  NTSTATUS st = pNtCreateFile(
      &h,
      access,
      &oa,
      &io,
      NULL,
      is_dir ? FILE_ATTRIBUTE_DIRECTORY : FILE_ATTRIBUTE_NORMAL,
      share_access,
      create_excl ? FILE_CREATE : FILE_OPEN,
      create_opts,
      NULL,
      0);
  if (st < 0) {
    DWORD dos = pRtlNtStatusToDosError(st);
    if (create_excl && dos == ERROR_ACCESS_DENIED &&
        win_case_insensitive_target_exists(parent, wname, wlen)) {
      dos = ERROR_ALREADY_EXISTS;
    } else if (!create_excl && (dos == ERROR_DIRECTORY || dos == ERROR_ACCESS_DENIED) &&
               win_is_reparse_point_rel(&oa)) {
      dos = ERROR_CANT_ACCESS_FILE;
    }
    *out_err = dos;
    return NULL;
  }

  FILE_ATTRIBUTE_TAG_INFO tag = {0};
  if (!GetFileInformationByHandleEx(h, FileAttributeTagInfo, &tag, sizeof(tag))) {
    *out_err = GetLastError();
    CloseHandle(h);
    return NULL;
  }
  if ((tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
    CloseHandle(h);
    *out_err = ERROR_CANT_ACCESS_FILE;
    return NULL;
  }
  if (is_dir && (tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0) {
    CloseHandle(h);
    *out_err = ERROR_DIRECTORY;
    return NULL;
  }
  if (!is_dir && (tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) {
    CloseHandle(h);
    *out_err = ERROR_ACCESS_DENIED;
    return NULL;
  }

  *out_err = 0;
  return h;
}

static bool win_rename_handle_excl(
    HANDLE src_h,
    HANDLE target_dir_h,
    const wchar_t *wnew,
    size_t wnew_len,
    const char *utf8_new,
    size_t utf8_new_len,
    DWORD *out_err) {
  ensure_ntdll();
  if (!validate_segment_utf16(wnew, wnew_len, utf8_new, utf8_new_len)) {
    *out_err = ERROR_INVALID_NAME;
    return false;
  }
  if (g_test_fi.mode == TEST_FI_ATOMIC_RENAME_ERRNO) {
    DWORD sim_err = (DWORD)g_test_fi.injected_errno;
    g_test_fi.mode = TEST_FI_NONE;
    *out_err = sim_err ? sim_err : ERROR_NOT_SUPPORTED;
    return false;
  }
  /* Case-insensitive existence guard (blocks case collisions even on WSL case-sensitive dirs) */
  if (win_case_insensitive_target_exists(target_dir_h, wnew, wnew_len)) {
    *out_err = ERROR_ALREADY_EXISTS;
    return false;
  }

  size_t name_bytes = wnew_len * sizeof(WCHAR);
  size_t sz = sizeof(ADHDEV_FILE_RENAME_INFO_EX) + name_bytes;
  ADHDEV_FILE_RENAME_INFO_EX *ri = (ADHDEV_FILE_RENAME_INFO_EX *)calloc(1, sz);
  if (!ri) {
    *out_err = ERROR_NOT_ENOUGH_MEMORY;
    return false;
  }
  ri->Flags = 0; /* No-replace (ReplaceIfExists = FALSE, POSIX_SEMANTICS = 0) */
  ri->RootDirectory = target_dir_h;
  ri->FileNameLength = (ULONG)name_bytes;
  memcpy(ri->FileName, wnew, name_bytes);

  IO_STATUS_BLOCK io = {0};
  NTSTATUS st = pNtSetInformationFile(src_h, &io, ri, (ULONG)sz, 65 /* FileRenameInformationEx */);
  if (st == STATUS_INVALID_INFO_CLASS || st == STATUS_NOT_SUPPORTED) {
    memset(&io, 0, sizeof(io));
    ri->ReplaceIfExists = FALSE;
    st = pNtSetInformationFile(src_h, &io, ri, (ULONG)sz, 10 /* FileRenameInformation */);
  }
  free(ri);

  if (st < 0) {
    DWORD dos = pRtlNtStatusToDosError(st);
    if (dos == ERROR_ACCESS_DENIED &&
        win_case_insensitive_target_exists(target_dir_h, wnew, wnew_len)) {
      dos = ERROR_ALREADY_EXISTS;
    }
    *out_err = dos;
    return false;
  }
  *out_err = 0;
  return true;
}
#endif

/* -------------------------------------------------------------------------
 * POSIX kernel primitive helpers
 * ------------------------------------------------------------------------- */
#ifndef _WIN32
/*
 * On macOS (XNU) and some BSDs, open/openat with O_DIRECTORY | O_NOFOLLOW (and
 * unlinkat with AT_REMOVEDIR) returns ENOTDIR (or EMLINK on FreeBSD) when the
 * target entry is a symbolic link, whereas Linux returns ELOOP.
 * Normalize symlink rejections to ELOOP while keeping genuine ENOTDIR for
 * regular files and other non-directory entries.
 */
static int normalize_posix_at_errno(int dir_fd, const char *seg, int err) {
  if (err == ENOTDIR || err == EMLINK) {
    struct stat st;
    if (fstatat(dir_fd, seg, &st, AT_SYMLINK_NOFOLLOW) == 0 && S_ISLNK(st.st_mode)) {
      return ELOOP;
    }
  }
  return err;
}

static bool posix_path_has_symlink(const char *norm_path) {
  char buf[PATH_MAX];
  size_t len = strlen(norm_path);
  if (len == 0 || len >= sizeof(buf)) return false;
  memcpy(buf, norm_path, len + 1);
  while (len > 1) {
    struct stat st;
    if (lstat(buf, &st) == 0 && S_ISLNK(st.st_mode)) {
      return true;
    }
    char *slash = strrchr(buf, '/');
    if (!slash || slash == buf) break;
    *slash = '\0';
    len = (size_t)(slash - buf);
  }
  return false;
}

static int posix_open_root_fd(const char *utf8_path, struct stat *out_st, int *out_err) {
  if (!utf8_path || utf8_path[0] != '/' || utf8_path[1] == '/') {
    *out_err = EINVAL;
    return -1;
  }
  size_t raw_len = strlen(utf8_path);
  if (raw_len == 0 || raw_len >= PATH_MAX) {
    *out_err = EINVAL;
    return -1;
  }
  char norm_path[PATH_MAX];
  memcpy(norm_path, utf8_path, raw_len + 1);
  while (raw_len > 1 && norm_path[raw_len - 1] == '/') {
    norm_path[--raw_len] = '\0';
  }

  int flags = O_RDONLY | O_DIRECTORY | O_NOFOLLOW;
#ifdef O_CLOEXEC
  flags |= O_CLOEXEC;
#endif
  int fd = open(norm_path, flags);
  if (fd < 0) {
    int err = errno;
    if ((err == ENOTDIR || err == EMLINK || err == ENOENT) && posix_path_has_symlink(norm_path)) {
      err = ELOOP;
    }
    *out_err = err;
    return -1;
  }

  struct stat st_fd, st_lstat, st_real;
  char real_buf[PATH_MAX];
  if (fstat(fd, &st_fd) != 0 ||
      lstat(norm_path, &st_lstat) != 0 ||
      !realpath(norm_path, real_buf) ||
      lstat(real_buf, &st_real) != 0) {
    int err = errno ? errno : ELOOP;
    if (posix_path_has_symlink(norm_path)) {
      err = ELOOP;
    }
    close(fd);
    *out_err = err;
    return -1;
  }
  if (!S_ISDIR(st_fd.st_mode)) {
    close(fd);
    *out_err = ENOTDIR;
    return -1;
  }
  if (S_ISLNK(st_lstat.st_mode) ||
      st_fd.st_dev != st_lstat.st_dev || st_fd.st_ino != st_lstat.st_ino ||
      st_fd.st_dev != st_real.st_dev || st_fd.st_ino != st_real.st_ino ||
      strcmp(real_buf, norm_path) != 0) {
    close(fd);
    *out_err = ELOOP;
    return -1;
  }
  if (out_st) {
    *out_st = st_fd;
  }
  *out_err = 0;
  return fd;
}

static bool posix_case_insensitive_target_exists(int dir_fd, const char *new_name) {
  int dup_fd = dup(dir_fd);
  if (dup_fd < 0) return false;
  DIR *d = fdopendir(dup_fd);
  if (!d) {
    close(dup_fd);
    return false;
  }
  rewinddir(d);
  struct dirent *ent = NULL;
  bool found = false;
  while ((ent = readdir(d)) != NULL) {
    if (strcasecmp(ent->d_name, new_name) == 0) {
      found = true;
      break;
    }
  }
  closedir(d);
  return found;
}

static int posix_atomic_rename_noreplace(
    int src_dir_fd,
    const char *src_name,
    int dst_dir_fd,
    const char *dst_name) {
  if (g_test_fi.mode == TEST_FI_ATOMIC_RENAME_ERRNO) {
    int sim_err = g_test_fi.injected_errno;
    g_test_fi.mode = TEST_FI_NONE;
    errno = sim_err;
    return -1;
  }
#if defined(__APPLE__)
  return renameatx_np(src_dir_fd, src_name, dst_dir_fd, dst_name, RENAME_EXCL);
#elif defined(__linux__)
  /*
   * Require kernel atomic RENAME_NOREPLACE (Linux >= 3.15).
   * Never fall back to linkat+unlinkat: linkat fails with EPERM on directories,
   * is non-atomic across two syscalls, and a crash between linkat and unlinkat
   * leaves a permanent st_nlink == 2 file that openFileRead rejects with EMLINK.
   */
  long rc = syscall(SYS_renameat2, src_dir_fd, src_name, dst_dir_fd, dst_name, RENAME_NOREPLACE);
  return (rc == 0) ? 0 : -1;
#else
  (void)src_dir_fd;
  (void)src_name;
  (void)dst_dir_fd;
  (void)dst_name;
  errno = ENOTSUP;
  return -1;
#endif
}

typedef enum {
  POSIX_RENAME_OK = 0,
  POSIX_RENAME_ERRNO = -1,
  POSIX_RENAME_QUARANTINED = -2,
  POSIX_RENAME_PUBLISHED_HARDLINK = -3,
  POSIX_RENAME_ATOMIC_UNSUPPORTED = -4
} posix_rename_status_t;

static uint32_t g_quarantine_seq = 0;

/*
 * Atomically move an unexpected or post-check-rejected entry out of
 * `(dst_dir_fd, dst_name)` into `quarantine_dir_fd` (the staging/source
 * directory on the same filesystem) under a unique `.adhdev-quarantine-*`
 * name using `posix_atomic_rename_noreplace`.
 *
 * Never calls `unlinkat`: user files, third-party files, and non-empty
 * directories are preserved intact inside `quarantine_dir_fd`.
 */
static bool posix_quarantine_entry(
    int dst_dir_fd,
    const char *dst_name,
    int quarantine_dir_fd,
    uint64_t unexpected_ino,
    char *out_qname,
    size_t out_qname_cap) {
  if (out_qname && out_qname_cap > 0) {
    out_qname[0] = '\0';
  }
  pid_t pid = getpid();
  for (uint32_t attempt = 0; attempt < 64; attempt++) {
    uint32_t seq = __atomic_fetch_add(&g_quarantine_seq, 1, __ATOMIC_RELAXED);
    char qname[256];
    int n = snprintf(
        qname,
        sizeof(qname),
        ".adhdev-quarantine-%d-%llx-%u-%u",
        (int)pid,
        (unsigned long long)unexpected_ino,
        (unsigned int)seq,
        (unsigned int)attempt);
    if (n <= 0 || (size_t)n >= sizeof(qname)) {
      return false;
    }
    if (posix_atomic_rename_noreplace(dst_dir_fd, dst_name, quarantine_dir_fd, qname) == 0) {
      if (out_qname && out_qname_cap > 0) {
        strncpy(out_qname, qname, out_qname_cap - 1);
        out_qname[out_qname_cap - 1] = '\0';
      }
      return true;
    }
    if (errno != EEXIST) {
      return false;
    }
  }
  return false;
}

/*
 * Open a file descriptor to pin `(dir_fd, name)` across `renameAtExcl`
 * without following symlinks:
 * - On Linux, uses `O_PATH | O_NOFOLLOW` so read permission on the source file
 *   or directory is NOT required (falls back to `O_RDONLY` only if `O_PATH` is
 *   rejected by an older kernel).
 * - On macOS/BSD, uses `O_SEARCH | O_DIRECTORY | O_NOFOLLOW` for directories
 *   where available so directory search (`x`) permission suffices without read
 *   (`r`) permission; for regular files on non-`O_PATH` platforms, uses
 *   `O_RDONLY | O_NOFOLLOW` (with `O_EVTONLY` fallback on macOS) and requires
 *   read permission on the source file.
 */
static int posix_open_pin_fd(int dir_fd, const char *name, mode_t lstat_mode) {
  int cloexec = 0;
#ifdef O_CLOEXEC
  cloexec |= O_CLOEXEC;
#endif
#if defined(__linux__) && defined(O_PATH)
  int path_fd = openat(dir_fd, name, O_PATH | O_NOFOLLOW | cloexec);
  if (path_fd >= 0 || (errno != EINVAL && errno != ENOSYS && errno != EOPNOTSUPP)) {
    return path_fd;
  }
#endif
#if defined(O_SEARCH)
  if (S_ISDIR(lstat_mode)) {
    int search_fd = openat(dir_fd, name, O_SEARCH | O_DIRECTORY | O_NOFOLLOW | cloexec);
    if (search_fd >= 0) {
      return search_fd;
    }
  }
#else
  (void)lstat_mode;
#endif
  int rd_flags = O_RDONLY | O_NOFOLLOW | cloexec;
#ifdef O_NONBLOCK
  rd_flags |= O_NONBLOCK;
#endif
  int rd_fd = openat(dir_fd, name, rd_flags);
#if defined(__APPLE__) && defined(O_EVTONLY)
  if (rd_fd < 0 && errno == EACCES) {
    int saved_rd_errno = errno;
    int evt_flags = O_EVTONLY | O_NOFOLLOW | cloexec;
#ifdef O_NONBLOCK
    evt_flags |= O_NONBLOCK;
#endif
    rd_fd = openat(dir_fd, name, evt_flags);
    if (rd_fd < 0) {
      errno = saved_rd_errno;
    }
  }
#endif
  return rd_fd;
}

/*
 * Verified atomic no-replace rename on POSIX:
 * 1. Runs the case-insensitive target scan BEFORE checking the source entry so
 *    directory iteration cannot widen the pre-check -> rename window.
 * 2. Requires an open file descriptor `src_fd` pinning `(expected_dev, expected_ino)`
 *    so the kernel cannot recycle `expected_ino` while the rename is in flight.
 * 3. Performs a tight `fstatat(AT_SYMLINK_NOFOLLOW)` + `fstat(src_fd)` pre-check
 *    followed immediately by `renameatx_np(..., RENAME_EXCL)` /
 *    `renameat2(..., RENAME_NOREPLACE)`.
 * 4. Performs a post-rename `fstatat` + `fstat(src_fd)` verification on
 *    `(dst_dir_fd, dst_name)`:
 *    - (F1) If `(dst_dir_fd, dst_name)` does not match `(expected_dev, expected_ino)`
 *      or the expected file type, it is NEVER unlinked/deleted; instead it is
 *      atomically renamed (no-replace) into `src_dir_fd` under a unique
 *      `.adhdev-quarantine-*` name (which works for regular files, symlinks, and
 *      non-empty directories alike) and fails closed with `POST_RENAME_QUARANTINED`.
 *    - (F2) If `(dst_dir_fd, dst_name)` matches `(expected_dev, expected_ino)` and
 *      file type, but `st_nlink != 1` on a regular file (a hardlink was added in the
 *      rename window), it is quarantined into `src_dir_fd` under `.adhdev-quarantine-*`
 *      and fails closed with `PUBLISHED_HARDLINK_DETECTED` (never plain `ELOOP`).
 *
 * Residual POSIX window documentation:
 * Unlike Windows `NtSetInformationFile(FileRenameInformationEx)` which renames an
 * open `HANDLE` directly, POSIX `renameat2`/`renameatx_np` operates on directory
 * entries by name. Two micro-windows exist when an adversary has concurrent write
 * access to `src_dir_fd` or `dst_dir_fd`:
 * - Window A (between pre-check `fstatat` and `posix_atomic_rename_noreplace`):
 *   if `src_name` is swapped before the kernel rename, the substituted entry is
 *   briefly visible at `(dst_dir_fd, dst_name)` until step 4 immediately moves it
 *   into `.adhdev-quarantine-*` inside `src_dir_fd`.
 * - Window B (between `posix_atomic_rename_noreplace` and step 4's `fstatat` /
 *   quarantine rename): if a third party replaces `(dst_dir_fd, dst_name)` before
 *   step 4 finishes, step 4 moves that entry intact into `.adhdev-quarantine-*`
 *   inside `src_dir_fd`. Because `unlinkat` is never used, no user or third-party
 *   data is ever deleted in either window.
 */
static posix_rename_status_t posix_rename_verified_excl(
    int src_fd,
    int src_dir_fd,
    const char *src_name,
    int dst_dir_fd,
    const char *dst_name,
    uint64_t expected_dev,
    uint64_t expected_ino,
    bool expected_is_dir,
    char *out_qname,
    size_t out_qname_cap) {
  if (out_qname && out_qname_cap > 0) {
    out_qname[0] = '\0';
  }
  if (posix_case_insensitive_target_exists(dst_dir_fd, dst_name)) {
    errno = EEXIST;
    return POSIX_RENAME_ERRNO;
  }

  struct stat st_pre;
  if (fstatat(src_dir_fd, src_name, &st_pre, AT_SYMLINK_NOFOLLOW) != 0) {
    errno = normalize_posix_at_errno(src_dir_fd, src_name, errno);
    return POSIX_RENAME_ERRNO;
  }
  if (S_ISLNK(st_pre.st_mode) ||
      (uint64_t)st_pre.st_dev != expected_dev ||
      (uint64_t)st_pre.st_ino != expected_ino ||
      (expected_is_dir ? !S_ISDIR(st_pre.st_mode) : !S_ISREG(st_pre.st_mode))) {
    errno = ELOOP;
    return POSIX_RENAME_ERRNO;
  }
  if (!expected_is_dir && st_pre.st_nlink != 1) {
    errno = EMLINK;
    return POSIX_RENAME_ERRNO;
  }

  if (src_fd >= 0) {
    struct stat st_fd;
    if (fstat(src_fd, &st_fd) != 0) {
      return POSIX_RENAME_ERRNO;
    }
    if ((uint64_t)st_fd.st_dev != expected_dev ||
        (uint64_t)st_fd.st_ino != expected_ino ||
        S_ISLNK(st_fd.st_mode) ||
        (expected_is_dir ? !S_ISDIR(st_fd.st_mode) : !S_ISREG(st_fd.st_mode))) {
      errno = ELOOP;
      return POSIX_RENAME_ERRNO;
    }
    if (!expected_is_dir && st_fd.st_nlink != 1) {
      errno = EMLINK;
      return POSIX_RENAME_ERRNO;
    }
  }

  bool fi_displaced = false;
  if (g_test_fi.mode == TEST_FI_SWAP_SRC_BEFORE_RENAME) {
    char aux[256];
    strncpy(aux, g_test_fi.aux_name, sizeof(aux) - 1);
    aux[sizeof(aux) - 1] = '\0';
    g_test_fi.mode = TEST_FI_NONE;
    if (renameat(src_dir_fd, src_name, src_dir_fd, ".adhdev-fi-displaced") == 0) {
      fi_displaced = true;
    }
    renameat(src_dir_fd, aux, src_dir_fd, src_name);
  }

  if (posix_atomic_rename_noreplace(src_dir_fd, src_name, dst_dir_fd, dst_name) != 0) {
    int ren_err = errno;
    if (fi_displaced) {
      unlinkat(src_dir_fd, ".adhdev-fi-displaced", expected_is_dir ? AT_REMOVEDIR : 0);
    }
    if (posix_is_atomic_noreplace_unsupported_errno(ren_err) || ren_err == EINVAL) {
      errno = ren_err;
      return POSIX_RENAME_ATOMIC_UNSUPPORTED;
    }
    errno = ren_err;
    return POSIX_RENAME_ERRNO;
  }

  if (g_test_fi.mode == TEST_FI_REPLACE_DST_AFTER_RENAME) {
    char aux[256];
    strncpy(aux, g_test_fi.aux_name, sizeof(aux) - 1);
    aux[sizeof(aux) - 1] = '\0';
    g_test_fi.mode = TEST_FI_NONE;
    if (renameat(dst_dir_fd, dst_name, src_dir_fd, ".adhdev-fi-displaced") == 0) {
      fi_displaced = true;
    }
    renameat(src_dir_fd, aux, dst_dir_fd, dst_name);
  } else if (g_test_fi.mode == TEST_FI_HARDLINK_AFTER_RENAME) {
    char aux[256];
    strncpy(aux, g_test_fi.aux_name, sizeof(aux) - 1);
    aux[sizeof(aux) - 1] = '\0';
    g_test_fi.mode = TEST_FI_NONE;
    linkat(dst_dir_fd, dst_name, src_dir_fd, aux, 0);
  }

  struct stat st_post;
  int post_stat_rc = fstatat(dst_dir_fd, dst_name, &st_post, AT_SYMLINK_NOFOLLOW);
  if (fi_displaced) {
    unlinkat(src_dir_fd, ".adhdev-fi-displaced", expected_is_dir ? AT_REMOVEDIR : 0);
  }
  bool identity_ok = (post_stat_rc == 0) &&
                     !S_ISLNK(st_post.st_mode) &&
                     (uint64_t)st_post.st_dev == expected_dev &&
                     (uint64_t)st_post.st_ino == expected_ino &&
                     (expected_is_dir ? S_ISDIR(st_post.st_mode) : S_ISREG(st_post.st_mode));
  struct stat st_fd_post;
  memset(&st_fd_post, 0, sizeof(st_fd_post));
  if (identity_ok && src_fd >= 0) {
    if (fstat(src_fd, &st_fd_post) != 0 ||
        (uint64_t)st_fd_post.st_dev != expected_dev ||
        (uint64_t)st_fd_post.st_ino != expected_ino ||
        S_ISLNK(st_fd_post.st_mode) ||
        (expected_is_dir ? !S_ISDIR(st_fd_post.st_mode) : !S_ISREG(st_fd_post.st_mode))) {
      identity_ok = false;
    }
  }

  if (!identity_ok) {
    uint64_t q_ino = (post_stat_rc == 0) ? (uint64_t)st_post.st_ino : expected_ino;
    posix_quarantine_entry(dst_dir_fd, dst_name, src_dir_fd, q_ino, out_qname, out_qname_cap);
    errno = ELOOP;
    return POSIX_RENAME_QUARANTINED;
  }

  if (!expected_is_dir &&
      (st_post.st_nlink != 1 || (src_fd >= 0 && st_fd_post.st_nlink != 1))) {
    posix_quarantine_entry(dst_dir_fd, dst_name, src_dir_fd, expected_ino, out_qname, out_qname_cap);
    errno = EMLINK;
    return POSIX_RENAME_PUBLISHED_HARDLINK;
  }

  return POSIX_RENAME_OK;
}

static napi_value throw_posix_rename_status(
    napi_env env,
    const char *op,
    posix_rename_status_t status,
    int err,
    const char *qname) {
  char msg[320];
  if (status == POSIX_RENAME_QUARANTINED) {
    if (qname && qname[0] != '\0') {
      snprintf(
          msg,
          sizeof(msg),
          "%s failed (POST_RENAME_QUARANTINED: unexpected destination entry quarantined as %s)",
          op,
          qname);
    } else {
      snprintf(
          msg,
          sizeof(msg),
          "%s failed (POST_RENAME_QUARANTINED: post-rename identity mismatch)",
          op);
    }
    napi_throw_error(env, "POST_RENAME_QUARANTINED", msg);
    return NULL;
  }
  if (status == POSIX_RENAME_PUBLISHED_HARDLINK) {
    if (qname && qname[0] != '\0') {
      snprintf(
          msg,
          sizeof(msg),
          "%s failed (PUBLISHED_HARDLINK_DETECTED: post-rename st_nlink != 1; quarantined as %s)",
          op,
          qname);
    } else {
      snprintf(
          msg,
          sizeof(msg),
          "%s failed (PUBLISHED_HARDLINK_DETECTED: post-rename st_nlink != 1)",
          op);
    }
    napi_throw_error(env, "PUBLISHED_HARDLINK_DETECTED", msg);
    return NULL;
  }
  if (status == POSIX_RENAME_ATOMIC_UNSUPPORTED) {
    snprintf(
        msg,
        sizeof(msg),
        "%s failed (ATOMIC_NOREPLACE_UNSUPPORTED / errno=%d: %s)",
        op,
        err,
        strerror(err));
    napi_throw_error(env, "ATOMIC_NOREPLACE_UNSUPPORTED", msg);
    return NULL;
  }
  return throw_posix_error(env, op, err);
}
#endif

/* -------------------------------------------------------------------------
 * Exported N-API functions
 * ------------------------------------------------------------------------- */

/* getBindingInfo() */
static napi_value fn_getBindingInfo(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value obj, v;
  napi_create_object(env, &obj);

  napi_create_int32(env, ADHDEV_TRANSFER_FS_API_LEVEL, &v);
  napi_set_named_property(env, obj, "apiLevel", v);

  napi_create_string_utf8(env, ADHDEV_TRANSFER_FS_SOURCE_DIGEST, NAPI_AUTO_LENGTH, &v);
  napi_set_named_property(env, obj, "sourceDigest", v);

  napi_create_int32(env, NAPI_VERSION, &v);
  napi_set_named_property(env, obj, "napiVersion", v);

  napi_create_string_utf8(env, ADHDEV_TRANSFER_FS_C_COMPILER, NAPI_AUTO_LENGTH, &v);
  napi_set_named_property(env, obj, "cCompiler", v);

  napi_create_string_utf8(env, ADHDEV_TRANSFER_FS_BUILD_TYPE, NAPI_AUTO_LENGTH, &v);
  napi_set_named_property(env, obj, "buildType", v);

  napi_get_boolean(env, true, &v);
  napi_set_named_property(env, obj, "releaseEligible", v);

  return obj;
}

/* openRoot(rootPath) -> handleToken */
static napi_value fn_openRoot(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1) {
    napi_throw_error(env, "EINVAL", "openRoot requires rootPath");
    return NULL;
  }

  char utf8_path[2048];
  size_t utf8_len = 0;
  if (!get_utf8_arg(env, argv[0], utf8_path, sizeof(utf8_path), &utf8_len) || utf8_len == 0) {
    napi_throw_error(env, "EINVAL", "Invalid rootPath");
    return NULL;
  }

#ifdef _WIN32
  wchar_t wpath[1024];
  size_t wlen = 0;
  if (!get_utf16_arg(env, argv[0], wpath, 1024, &wlen) || wlen == 0) {
    napi_throw_error(env, "EINVAL", "Invalid rootPath UTF-16");
    return NULL;
  }
  DWORD err = 0;
  HANDLE h = win_open_root_internal(wpath, &err);
  if (h == INVALID_HANDLE_VALUE) {
    return throw_win_error(env, "openRoot", err);
  }
  int64_t tok = alloc_win_slot(h, true, true);
  if (tok < 0) {
    CloseHandle(h);
    napi_throw_error(env, "EMFILE", "Handle table full");
    return NULL;
  }
  return create_handle_value(env, tok);
#else
  struct stat st_fd;
  int err = 0;
  int fd = posix_open_root_fd(utf8_path, &st_fd, &err);
  if (fd < 0) {
    return throw_posix_error(env, "openRoot", err);
  }
  int64_t tok = alloc_posix_slot(fd, true, true, -1, 0, NULL, (uint64_t)st_fd.st_dev, (uint64_t)st_fd.st_ino);
  if (tok < 0) {
    close(fd);
    napi_throw_error(env, "EMFILE", "Handle table full");
    return NULL;
  }
  return create_handle_value(env, tok);
#endif
}

/* walkDir(parentHandle, segment) -> handleToken */
static napi_value fn_walkDir(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 2) {
    napi_throw_error(env, "EINVAL", "walkDir requires (parentHandle, segment)");
    return NULL;
  }
  int64_t parent_tok = 0;
  if (!get_handle_token(env, argv[0], &parent_tok)) {
    napi_throw_error(env, "EBADF", "Invalid parentHandle");
    return NULL;
  }
  char utf8_seg[512];
  size_t utf8_len = 0;
  if (!get_utf8_arg(env, argv[1], utf8_seg, sizeof(utf8_seg), &utf8_len)) {
    napi_throw_error(env, "EINVAL", "Invalid segment");
    return NULL;
  }

#ifdef _WIN32
  HANDLE parent_h = NULL;
  bool parent_is_dir = false;
  if (!lookup_win_slot(parent_tok, &parent_h, &parent_is_dir) || !parent_is_dir) {
    napi_throw_error(env, "EBADF", "Parent handle is closed or not a directory");
    return NULL;
  }
  wchar_t wseg[512];
  size_t wlen = 0;
  if (!get_utf16_arg(env, argv[1], wseg, 512, &wlen)) {
    napi_throw_error(env, "EINVAL", "Invalid UTF-16 segment");
    return NULL;
  }
  DWORD err = 0;
  HANDLE h = win_open_rel_internal(parent_h, wseg, wlen, utf8_seg, utf8_len, true, false, false, &err);
  if (!h) {
    return throw_win_error(env, "walkDir", err);
  }
  int64_t tok = alloc_win_slot(h, true, false);
  if (tok < 0) {
    CloseHandle(h);
    napi_throw_error(env, "EMFILE", "Handle table full");
    return NULL;
  }
  return create_handle_value(env, tok);
#else
  int parent_fd = -1, parent_slot = -1;
  uint32_t parent_gen = 0;
  bool parent_is_dir = false;
  if (!lookup_posix_slot(parent_tok, &parent_fd, &parent_is_dir, &parent_slot, &parent_gen) || !parent_is_dir) {
    napi_throw_error(env, "EBADF", "Parent handle is closed or not a directory");
    return NULL;
  }
  if (!validate_segment_utf8(utf8_seg, utf8_len)) {
    napi_throw_error(env, "EINVAL", "Invalid segment in walkDir");
    return NULL;
  }
  int flags = O_RDONLY | O_DIRECTORY | O_NOFOLLOW;
#ifdef O_CLOEXEC
  flags |= O_CLOEXEC;
#endif
  int fd = openat(parent_fd, utf8_seg, flags);
  if (fd < 0) {
    return throw_posix_error(env, "walkDir", normalize_posix_at_errno(parent_fd, utf8_seg, errno));
  }
  struct stat st;
  if (fstat(fd, &st) != 0 || !S_ISDIR(st.st_mode)) {
    close(fd);
    napi_throw_error(env, "ENOTDIR", "walkDir target is not a directory");
    return NULL;
  }
  int64_t tok = alloc_posix_slot(fd, true, false, parent_slot, parent_gen, utf8_seg, (uint64_t)st.st_dev, (uint64_t)st.st_ino);
  if (tok < 0) {
    close(fd);
    napi_throw_error(env, "EMFILE", "Handle table full");
    return NULL;
  }
  return create_handle_value(env, tok);
#endif
}

/* mkdirExcl(parentHandle, segment) -> handleToken */
static napi_value fn_mkdirExcl(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 2) {
    napi_throw_error(env, "EINVAL", "mkdirExcl requires (parentHandle, segment)");
    return NULL;
  }
  int64_t parent_tok = 0;
  if (!get_handle_token(env, argv[0], &parent_tok)) {
    napi_throw_error(env, "EBADF", "Invalid parentHandle");
    return NULL;
  }
  char utf8_seg[512];
  size_t utf8_len = 0;
  if (!get_utf8_arg(env, argv[1], utf8_seg, sizeof(utf8_seg), &utf8_len)) {
    napi_throw_error(env, "EINVAL", "Invalid segment");
    return NULL;
  }

#ifdef _WIN32
  HANDLE parent_h = NULL;
  bool parent_is_dir = false;
  if (!lookup_win_slot(parent_tok, &parent_h, &parent_is_dir) || !parent_is_dir) {
    napi_throw_error(env, "EBADF", "Parent handle is closed or not a directory");
    return NULL;
  }
  wchar_t wseg[512];
  size_t wlen = 0;
  if (!get_utf16_arg(env, argv[1], wseg, 512, &wlen)) {
    napi_throw_error(env, "EINVAL", "Invalid UTF-16 segment");
    return NULL;
  }
  DWORD err = 0;
  HANDLE h = win_open_rel_internal(parent_h, wseg, wlen, utf8_seg, utf8_len, true, true, false, &err);
  if (!h) {
    return throw_win_error(env, "mkdirExcl", err);
  }
  int64_t tok = alloc_win_slot(h, true, false);
  if (tok < 0) {
    CloseHandle(h);
    napi_throw_error(env, "EMFILE", "Handle table full");
    return NULL;
  }
  return create_handle_value(env, tok);
#else
  int parent_fd = -1, parent_slot = -1;
  uint32_t parent_gen = 0;
  bool parent_is_dir = false;
  if (!lookup_posix_slot(parent_tok, &parent_fd, &parent_is_dir, &parent_slot, &parent_gen) || !parent_is_dir) {
    napi_throw_error(env, "EBADF", "Parent handle is closed or not a directory");
    return NULL;
  }
  if (!validate_segment_utf8(utf8_seg, utf8_len)) {
    napi_throw_error(env, "EINVAL", "Invalid segment in mkdirExcl");
    return NULL;
  }
  if (posix_case_insensitive_target_exists(parent_fd, utf8_seg)) {
    return throw_posix_error(env, "mkdirExcl", EEXIST);
  }
  if (mkdirat(parent_fd, utf8_seg, 0700) != 0) {
    return throw_posix_error(env, "mkdirExcl", errno);
  }
  int flags = O_RDONLY | O_DIRECTORY | O_NOFOLLOW;
#ifdef O_CLOEXEC
  flags |= O_CLOEXEC;
#endif
  int fd = openat(parent_fd, utf8_seg, flags);
  if (fd < 0) {
    return throw_posix_error(env, "mkdirExcl(openat)", normalize_posix_at_errno(parent_fd, utf8_seg, errno));
  }
  struct stat st;
  if (fstat(fd, &st) != 0 || !S_ISDIR(st.st_mode)) {
    close(fd);
    napi_throw_error(env, "ENOTDIR", "mkdirExcl target is not a directory");
    return NULL;
  }
  int64_t tok = alloc_posix_slot(fd, true, false, parent_slot, parent_gen, utf8_seg, (uint64_t)st.st_dev, (uint64_t)st.st_ino);
  if (tok < 0) {
    close(fd);
    napi_throw_error(env, "EMFILE", "Handle table full");
    return NULL;
  }
  return create_handle_value(env, tok);
#endif
}

/* createExcl(parentHandle, segment) -> handleToken */
static napi_value fn_createExcl(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 2) {
    napi_throw_error(env, "EINVAL", "createExcl requires (parentHandle, segment)");
    return NULL;
  }
  int64_t parent_tok = 0;
  if (!get_handle_token(env, argv[0], &parent_tok)) {
    napi_throw_error(env, "EBADF", "Invalid parentHandle");
    return NULL;
  }
  char utf8_seg[512];
  size_t utf8_len = 0;
  if (!get_utf8_arg(env, argv[1], utf8_seg, sizeof(utf8_seg), &utf8_len)) {
    napi_throw_error(env, "EINVAL", "Invalid segment");
    return NULL;
  }

#ifdef _WIN32
  HANDLE parent_h = NULL;
  bool parent_is_dir = false;
  if (!lookup_win_slot(parent_tok, &parent_h, &parent_is_dir) || !parent_is_dir) {
    napi_throw_error(env, "EBADF", "Parent handle is closed or not a directory");
    return NULL;
  }
  wchar_t wseg[512];
  size_t wlen = 0;
  if (!get_utf16_arg(env, argv[1], wseg, 512, &wlen)) {
    napi_throw_error(env, "EINVAL", "Invalid UTF-16 segment");
    return NULL;
  }
  DWORD err = 0;
  HANDLE h = win_open_rel_internal(parent_h, wseg, wlen, utf8_seg, utf8_len, false, true, false, &err);
  if (!h) {
    return throw_win_error(env, "createExcl", err);
  }
  int64_t tok = alloc_win_slot(h, false, false);
  if (tok < 0) {
    CloseHandle(h);
    napi_throw_error(env, "EMFILE", "Handle table full");
    return NULL;
  }
  return create_handle_value(env, tok);
#else
  int parent_fd = -1, parent_slot = -1;
  uint32_t parent_gen = 0;
  bool parent_is_dir = false;
  if (!lookup_posix_slot(parent_tok, &parent_fd, &parent_is_dir, &parent_slot, &parent_gen) || !parent_is_dir) {
    napi_throw_error(env, "EBADF", "Parent handle is closed or not a directory");
    return NULL;
  }
  if (!validate_segment_utf8(utf8_seg, utf8_len)) {
    napi_throw_error(env, "EINVAL", "Invalid segment in createExcl");
    return NULL;
  }
  if (posix_case_insensitive_target_exists(parent_fd, utf8_seg)) {
    return throw_posix_error(env, "createExcl", EEXIST);
  }
  int flags = O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW;
#ifdef O_CLOEXEC
  flags |= O_CLOEXEC;
#endif
  int fd = openat(parent_fd, utf8_seg, flags, 0600);
  if (fd < 0) {
    return throw_posix_error(env, "createExcl", errno);
  }
  struct stat st;
  if (fstat(fd, &st) != 0 || !S_ISREG(st.st_mode)) {
    close(fd);
    napi_throw_error(env, "EINVAL", "createExcl did not produce a regular file");
    return NULL;
  }
  int64_t tok = alloc_posix_slot(fd, false, false, parent_slot, parent_gen, utf8_seg, (uint64_t)st.st_dev, (uint64_t)st.st_ino);
  if (tok < 0) {
    close(fd);
    napi_throw_error(env, "EMFILE", "Handle table full");
    return NULL;
  }
  return create_handle_value(env, tok);
#endif
}

/* openFileRead(parentHandle, segment) -> handleToken (rejects symlinks/reparse and hardlinks nlink > 1) */
static napi_value fn_openFileRead(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 2) {
    napi_throw_error(env, "EINVAL", "openFileRead requires (parentHandle, segment)");
    return NULL;
  }
  int64_t parent_tok = 0;
  if (!get_handle_token(env, argv[0], &parent_tok)) {
    napi_throw_error(env, "EBADF", "Invalid parentHandle");
    return NULL;
  }
  char utf8_seg[512];
  size_t utf8_len = 0;
  if (!get_utf8_arg(env, argv[1], utf8_seg, sizeof(utf8_seg), &utf8_len)) {
    napi_throw_error(env, "EINVAL", "Invalid segment");
    return NULL;
  }

#ifdef _WIN32
  HANDLE parent_h = NULL;
  bool parent_is_dir = false;
  if (!lookup_win_slot(parent_tok, &parent_h, &parent_is_dir) || !parent_is_dir) {
    napi_throw_error(env, "EBADF", "Parent handle is closed or not a directory");
    return NULL;
  }
  wchar_t wseg[512];
  size_t wlen = 0;
  if (!get_utf16_arg(env, argv[1], wseg, 512, &wlen)) {
    napi_throw_error(env, "EINVAL", "Invalid UTF-16 segment");
    return NULL;
  }
  DWORD err = 0;
  HANDLE h = win_open_rel_internal(parent_h, wseg, wlen, utf8_seg, utf8_len, false, false, true, &err);
  if (!h) {
    return throw_win_error(env, "openFileRead", err);
  }
  BY_HANDLE_FILE_INFORMATION bhfi = {0};
  if (!GetFileInformationByHandle(h, &bhfi)) {
    DWORD gerr = GetLastError();
    CloseHandle(h);
    return throw_win_error(env, "openFileRead(stat)", gerr);
  }
  if (bhfi.nNumberOfLinks > 1) {
    CloseHandle(h);
    napi_throw_error(env, "EMLINK", "Hardlinked file rejected (nNumberOfLinks > 1)");
    return NULL;
  }
  int64_t tok = alloc_win_slot(h, false, false);
  if (tok < 0) {
    CloseHandle(h);
    napi_throw_error(env, "EMFILE", "Handle table full");
    return NULL;
  }
  return create_handle_value(env, tok);
#else
  int parent_fd = -1, parent_slot = -1;
  uint32_t parent_gen = 0;
  bool parent_is_dir = false;
  if (!lookup_posix_slot(parent_tok, &parent_fd, &parent_is_dir, &parent_slot, &parent_gen) || !parent_is_dir) {
    napi_throw_error(env, "EBADF", "Parent handle is closed or not a directory");
    return NULL;
  }
  if (!validate_segment_utf8(utf8_seg, utf8_len)) {
    napi_throw_error(env, "EINVAL", "Invalid segment in openFileRead");
    return NULL;
  }
  int flags = O_RDONLY | O_NOFOLLOW;
#ifdef O_NONBLOCK
  flags |= O_NONBLOCK;
#endif
#ifdef O_CLOEXEC
  flags |= O_CLOEXEC;
#endif
  int fd = openat(parent_fd, utf8_seg, flags);
  if (fd < 0) {
    return throw_posix_error(env, "openFileRead", normalize_posix_at_errno(parent_fd, utf8_seg, errno));
  }
  struct stat st;
  if (fstat(fd, &st) != 0) {
    int saved = errno;
    close(fd);
    return throw_posix_error(env, "openFileRead(fstat)", saved);
  }
  if (S_ISLNK(st.st_mode)) {
    close(fd);
    return throw_posix_error(env, "openFileRead", ELOOP);
  }
  if (!S_ISREG(st.st_mode)) {
    close(fd);
    napi_throw_error(env, "EISDIR", "openFileRead target is not a regular file");
    return NULL;
  }
  if (st.st_nlink > 1) {
    close(fd);
    napi_throw_error(env, "EMLINK", "Hardlinked file rejected (st_nlink > 1)");
    return NULL;
  }
  int64_t tok = alloc_posix_slot(fd, false, false, parent_slot, parent_gen, utf8_seg, (uint64_t)st.st_dev, (uint64_t)st.st_ino);
  if (tok < 0) {
    close(fd);
    napi_throw_error(env, "EMFILE", "Handle table full");
    return NULL;
  }
  return create_handle_value(env, tok);
#endif
}

/* renameExcl(srcHandle, targetDirHandle, newName) -> boolean */
static napi_value fn_renameExcl(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 3) {
    napi_throw_error(env, "EINVAL", "renameExcl requires (srcHandle, targetDirHandle, newName)");
    return NULL;
  }
  int64_t src_tok = 0, dst_dir_tok = 0;
  if (!get_handle_token(env, argv[0], &src_tok) || !get_handle_token(env, argv[1], &dst_dir_tok)) {
    napi_throw_error(env, "EBADF", "Invalid handle in renameExcl");
    return NULL;
  }
  char utf8_new[512];
  size_t utf8_new_len = 0;
  if (!get_utf8_arg(env, argv[2], utf8_new, sizeof(utf8_new), &utf8_new_len)) {
    napi_throw_error(env, "EINVAL", "Invalid newName");
    return NULL;
  }

#ifdef _WIN32
  HANDLE src_h = NULL, dst_dir_h = NULL;
  bool src_is_dir = false, dst_is_dir = false;
  if (!lookup_win_slot(src_tok, &src_h, &src_is_dir)) {
    napi_throw_error(env, "EBADF", "srcHandle is closed or invalid");
    return NULL;
  }
  if (!lookup_win_slot(dst_dir_tok, &dst_dir_h, &dst_is_dir) || !dst_is_dir) {
    napi_throw_error(env, "EBADF", "targetDirHandle is closed or not a directory");
    return NULL;
  }
  wchar_t wnew[512];
  size_t wnew_len = 0;
  if (!get_utf16_arg(env, argv[2], wnew, 512, &wnew_len)) {
    napi_throw_error(env, "EINVAL", "Invalid UTF-16 newName");
    return NULL;
  }
  DWORD err = 0;
  if (!win_rename_handle_excl(src_h, dst_dir_h, wnew, wnew_len, utf8_new, utf8_new_len, &err)) {
    return throw_win_error(env, "renameExcl", err);
  }
  napi_value ok;
  napi_get_boolean(env, true, &ok);
  return ok;
#else
  if (!validate_segment_utf8(utf8_new, utf8_new_len)) {
    napi_throw_error(env, "EINVAL", "Invalid newName segment in renameExcl");
    return NULL;
  }
  int src_slot = 0, dst_slot = 0;
  uint32_t src_gen = 0, dst_gen = 0;
  if (!parse_token(src_tok, &src_slot, &src_gen) || !parse_token(dst_dir_tok, &dst_slot, &dst_gen)) {
    napi_throw_error(env, "EBADF", "Invalid handle token");
    return NULL;
  }
  LOCK_SLOTS();
  handle_slot_t *s_src = &g_slots[src_slot];
  handle_slot_t *s_dst = &g_slots[dst_slot];
  if (!s_src->active || s_src->generation != src_gen || s_src->is_root || s_src->parent_slot < 0) {
    UNLOCK_SLOTS();
    napi_throw_error(env, "EBADF", "srcHandle is closed or cannot be renamed");
    return NULL;
  }
  if (!s_dst->active || s_dst->generation != dst_gen || !s_dst->is_dir) {
    UNLOCK_SLOTS();
    napi_throw_error(env, "EBADF", "targetDirHandle is closed or not a directory");
    return NULL;
  }
  handle_slot_t *s_parent = &g_slots[s_src->parent_slot];
  if (!s_parent->active || s_parent->generation != s_src->parent_gen || !s_parent->is_dir) {
    UNLOCK_SLOTS();
    napi_throw_error(env, "EBADF", "srcHandle parent directory handle is no longer open");
    return NULL;
  }
  int src_fd = s_src->fd;
  bool expected_is_dir = s_src->is_dir;
  int parent_fd = s_parent->fd;
  int dst_fd = s_dst->fd;
  char src_name[256];
  strncpy(src_name, s_src->name, sizeof(src_name) - 1);
  src_name[sizeof(src_name) - 1] = '\0';
  uint64_t expected_dev = s_src->dev;
  uint64_t expected_ino = s_src->ino;
  UNLOCK_SLOTS();

  char qname[256] = {0};
  posix_rename_status_t rstat = posix_rename_verified_excl(
      src_fd,
      parent_fd,
      src_name,
      dst_fd,
      utf8_new,
      expected_dev,
      expected_ino,
      expected_is_dir,
      qname,
      sizeof(qname));
  int saved_err = errno;
  if (rstat != POSIX_RENAME_OK) {
    if (rstat == POSIX_RENAME_PUBLISHED_HARDLINK && qname[0] != '\0') {
      LOCK_SLOTS();
      if (g_slots[src_slot].active && g_slots[src_slot].generation == src_gen) {
        strncpy(g_slots[src_slot].name, qname, sizeof(g_slots[src_slot].name) - 1);
        g_slots[src_slot].name[sizeof(g_slots[src_slot].name) - 1] = '\0';
      }
      UNLOCK_SLOTS();
    }
    return throw_posix_rename_status(env, "renameExcl", rstat, saved_err, qname);
  }
  LOCK_SLOTS();
  if (g_slots[src_slot].active && g_slots[src_slot].generation == src_gen) {
    g_slots[src_slot].parent_slot = dst_slot;
    g_slots[src_slot].parent_gen = dst_gen;
    strncpy(g_slots[src_slot].name, utf8_new, sizeof(g_slots[src_slot].name) - 1);
    g_slots[src_slot].name[sizeof(g_slots[src_slot].name) - 1] = '\0';
  }
  UNLOCK_SLOTS();

  napi_value ok;
  napi_get_boolean(env, true, &ok);
  return ok;
#endif
}

/* renameAtExcl(srcDirHandle, srcName, targetDirHandle, newName) -> boolean */
static napi_value fn_renameAtExcl(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 4) {
    napi_throw_error(env, "EINVAL", "renameAtExcl requires (srcDirHandle, srcName, targetDirHandle, newName)");
    return NULL;
  }
  int64_t src_dir_tok = 0, dst_dir_tok = 0;
  if (!get_handle_token(env, argv[0], &src_dir_tok) || !get_handle_token(env, argv[2], &dst_dir_tok)) {
    napi_throw_error(env, "EBADF", "Invalid directory handle in renameAtExcl");
    return NULL;
  }
  char utf8_src[512], utf8_new[512];
  size_t utf8_src_len = 0, utf8_new_len = 0;
  if (!get_utf8_arg(env, argv[1], utf8_src, sizeof(utf8_src), &utf8_src_len) ||
      !get_utf8_arg(env, argv[3], utf8_new, sizeof(utf8_new), &utf8_new_len)) {
    napi_throw_error(env, "EINVAL", "Invalid segment in renameAtExcl");
    return NULL;
  }

#ifdef _WIN32
  ensure_ntdll();
  HANDLE src_dir_h = NULL, dst_dir_h = NULL;
  bool src_is_dir = false, dst_is_dir = false;
  if (!lookup_win_slot(src_dir_tok, &src_dir_h, &src_is_dir) || !src_is_dir ||
      !lookup_win_slot(dst_dir_tok, &dst_dir_h, &dst_is_dir) || !dst_is_dir) {
    napi_throw_error(env, "EBADF", "Directory handle is closed or not a directory");
    return NULL;
  }
  wchar_t wsrc[512], wnew[512];
  size_t wsrc_len = 0, wnew_len = 0;
  if (!get_utf16_arg(env, argv[1], wsrc, 512, &wsrc_len) ||
      !get_utf16_arg(env, argv[3], wnew, 512, &wnew_len)) {
    napi_throw_error(env, "EINVAL", "Invalid UTF-16 segment in renameAtExcl");
    return NULL;
  }
  if (!validate_segment_utf16(wsrc, wsrc_len, utf8_src, utf8_src_len) ||
      !validate_segment_utf16(wnew, wnew_len, utf8_new, utf8_new_len)) {
    return throw_win_error(env, "renameAtExcl", ERROR_INVALID_NAME);
  }
  UNICODE_STRING us;
  us.Buffer = wsrc;
  us.Length = (USHORT)(wsrc_len * sizeof(WCHAR));
  us.MaximumLength = (USHORT)((wsrc_len + 1) * sizeof(WCHAR));
  OBJECT_ATTRIBUTES oa;
  InitializeObjectAttributes(&oa, &us, OBJ_CASE_INSENSITIVE, src_dir_h, NULL);
  IO_STATUS_BLOCK io = {0};
  HANDLE tmp_h = NULL;
  NTSTATUS st = pNtCreateFile(
      &tmp_h,
      DELETE | SYNCHRONIZE | FILE_READ_ATTRIBUTES,
      &oa,
      &io,
      NULL,
      FILE_ATTRIBUTE_NORMAL,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      FILE_OPEN,
      FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
      NULL,
      0);
  if (st < 0) {
    return throw_win_error(env, "renameAtExcl(openSrc)", pRtlNtStatusToDosError(st));
  }
  FILE_ATTRIBUTE_TAG_INFO tag = {0};
  if (!GetFileInformationByHandleEx(tmp_h, FileAttributeTagInfo, &tag, sizeof(tag)) ||
      (tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
    CloseHandle(tmp_h);
    return throw_win_error(env, "renameAtExcl", ERROR_CANT_ACCESS_FILE);
  }
  DWORD err = 0;
  bool ok_ren = win_rename_handle_excl(tmp_h, dst_dir_h, wnew, wnew_len, utf8_new, utf8_new_len, &err);
  CloseHandle(tmp_h);
  if (!ok_ren) {
    return throw_win_error(env, "renameAtExcl", err);
  }
  napi_value ok;
  napi_get_boolean(env, true, &ok);
  return ok;
#else
  int src_dir_fd = -1, dst_dir_fd = -1;
  bool src_is_dir = false, dst_is_dir = false;
  if (!lookup_posix_slot(src_dir_tok, &src_dir_fd, &src_is_dir, NULL, NULL) || !src_is_dir ||
      !lookup_posix_slot(dst_dir_tok, &dst_dir_fd, &dst_is_dir, NULL, NULL) || !dst_is_dir) {
    napi_throw_error(env, "EBADF", "Directory handle is closed or not a directory");
    return NULL;
  }
  if (!validate_segment_utf8(utf8_src, utf8_src_len) ||
      !validate_segment_utf8(utf8_new, utf8_new_len)) {
    napi_throw_error(env, "EINVAL", "Invalid segment in renameAtExcl");
    return NULL;
  }
  struct stat st_lstat;
  if (fstatat(src_dir_fd, utf8_src, &st_lstat, AT_SYMLINK_NOFOLLOW) != 0) {
    return throw_posix_error(env, "renameAtExcl(lstat)", normalize_posix_at_errno(src_dir_fd, utf8_src, errno));
  }
  if (S_ISLNK(st_lstat.st_mode)) {
    napi_throw_error(env, "ELOOP", "renameAtExcl refuses to rename symbolic links");
    return NULL;
  }
  int tmp_fd = posix_open_pin_fd(src_dir_fd, utf8_src, st_lstat.st_mode);
  if (tmp_fd < 0) {
    return throw_posix_error(env, "renameAtExcl(openSrc)", normalize_posix_at_errno(src_dir_fd, utf8_src, errno));
  }
  struct stat st_fd;
  if (fstat(tmp_fd, &st_fd) != 0 ||
      S_ISLNK(st_fd.st_mode) ||
      st_fd.st_dev != st_lstat.st_dev ||
      st_fd.st_ino != st_lstat.st_ino ||
      (!S_ISREG(st_fd.st_mode) && !S_ISDIR(st_fd.st_mode))) {
    close(tmp_fd);
    napi_throw_error(env, "ELOOP", "renameAtExcl source entry identity changed during open");
    return NULL;
  }
  if (S_ISREG(st_fd.st_mode) && st_fd.st_nlink > 1) {
    close(tmp_fd);
    napi_throw_error(env, "EMLINK", "renameAtExcl refuses to rename hardlinked files");
    return NULL;
  }
  char qname[256] = {0};
  posix_rename_status_t rstat = posix_rename_verified_excl(
      tmp_fd,
      src_dir_fd,
      utf8_src,
      dst_dir_fd,
      utf8_new,
      (uint64_t)st_fd.st_dev,
      (uint64_t)st_fd.st_ino,
      S_ISDIR(st_fd.st_mode),
      qname,
      sizeof(qname));
  int saved_err = errno;
  close(tmp_fd);
  if (rstat != POSIX_RENAME_OK) {
    return throw_posix_rename_status(env, "renameAtExcl", rstat, saved_err, qname);
  }
  napi_value ok;
  napi_get_boolean(env, true, &ok);
  return ok;
#endif
}

/* writeHandle(handle, buffer[, offset, length, position]) -> bytesWritten */
static napi_value fn_writeHandle(napi_env env, napi_callback_info info) {
  size_t argc = 5;
  napi_value argv[5];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 2) {
    napi_throw_error(env, "EINVAL", "writeHandle requires (handle, buffer)");
    return NULL;
  }
  int64_t tok = 0;
  if (!get_handle_token(env, argv[0], &tok)) {
    napi_throw_error(env, "EBADF", "Invalid handle");
    return NULL;
  }
  void *buf_ptr = NULL;
  size_t buf_len = 0;
  if (napi_get_buffer_info(env, argv[1], &buf_ptr, &buf_len) != napi_ok) {
    napi_throw_error(env, "EINVAL", "Second argument must be a Buffer");
    return NULL;
  }
  size_t offset = 0;
  size_t length = buf_len;
  int64_t position = -1;
  if (argc >= 3) {
    napi_valuetype t;
    if (napi_typeof(env, argv[2], &t) == napi_ok && t == napi_number) {
      int64_t off_v = 0;
      napi_get_value_int64(env, argv[2], &off_v);
      if (off_v < 0 || (size_t)off_v > buf_len) {
        napi_throw_error(env, "EINVAL", "Buffer offset out of range");
        return NULL;
      }
      offset = (size_t)off_v;
      length = buf_len - offset;
    }
  }
  if (argc >= 4) {
    napi_valuetype t;
    if (napi_typeof(env, argv[3], &t) == napi_ok && t == napi_number) {
      int64_t len_v = 0;
      napi_get_value_int64(env, argv[3], &len_v);
      if (len_v < 0 || offset + (size_t)len_v > buf_len) {
        napi_throw_error(env, "EINVAL", "Buffer length out of range");
        return NULL;
      }
      length = (size_t)len_v;
    }
  }
  if (argc >= 5) {
    napi_valuetype t;
    if (napi_typeof(env, argv[4], &t) == napi_ok && t == napi_number) {
      napi_get_value_int64(env, argv[4], &position);
    }
  }

  const uint8_t *ptr = (const uint8_t *)buf_ptr + offset;

#ifdef _WIN32
  HANDLE h = NULL;
  bool is_dir = false;
  if (!lookup_win_slot(tok, &h, &is_dir) || is_dir) {
    napi_throw_error(env, "EBADF", "File handle is closed or is a directory");
    return NULL;
  }
  if (position >= 0) {
    LARGE_INTEGER li;
    li.QuadPart = position;
    if (!SetFilePointerEx(h, li, NULL, FILE_BEGIN)) {
      return throw_win_error(env, "writeHandle(seek)", GetLastError());
    }
  }
  size_t total = 0;
  while (total < length) {
    DWORD chunk = (length - total > 0x40000000) ? 0x40000000 : (DWORD)(length - total);
    DWORD written = 0;
    if (!WriteFile(h, ptr + total, chunk, &written, NULL)) {
      return throw_win_error(env, "writeHandle", GetLastError());
    }
    if (written == 0) break;
    total += written;
  }
  napi_value out;
  napi_create_int64(env, (int64_t)total, &out);
  return out;
#else
  int fd = -1;
  bool is_dir = false;
  if (!lookup_posix_slot(tok, &fd, &is_dir, NULL, NULL) || is_dir) {
    napi_throw_error(env, "EBADF", "File handle is closed or is a directory");
    return NULL;
  }
  size_t total = 0;
  while (total < length) {
    ssize_t n = (position >= 0)
        ? pwrite(fd, ptr + total, length - total, (off_t)(position + (int64_t)total))
        : write(fd, ptr + total, length - total);
    if (n < 0) {
      if (errno == EINTR) continue;
      return throw_posix_error(env, "writeHandle", errno);
    }
    if (n == 0) break;
    total += (size_t)n;
  }
  napi_value out;
  napi_create_int64(env, (int64_t)total, &out);
  return out;
#endif
}

/* readHandle(handle, buffer[, offset, length, position]) -> bytesRead */
static napi_value fn_readHandle(napi_env env, napi_callback_info info) {
  size_t argc = 5;
  napi_value argv[5];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 2) {
    napi_throw_error(env, "EINVAL", "readHandle requires (handle, buffer)");
    return NULL;
  }
  int64_t tok = 0;
  if (!get_handle_token(env, argv[0], &tok)) {
    napi_throw_error(env, "EBADF", "Invalid handle");
    return NULL;
  }
  void *buf_ptr = NULL;
  size_t buf_len = 0;
  if (napi_get_buffer_info(env, argv[1], &buf_ptr, &buf_len) != napi_ok) {
    napi_throw_error(env, "EINVAL", "Second argument must be a Buffer");
    return NULL;
  }
  size_t offset = 0;
  size_t length = buf_len;
  int64_t position = -1;
  if (argc >= 3) {
    napi_valuetype t;
    if (napi_typeof(env, argv[2], &t) == napi_ok && t == napi_number) {
      int64_t off_v = 0;
      napi_get_value_int64(env, argv[2], &off_v);
      if (off_v < 0 || (size_t)off_v > buf_len) {
        napi_throw_error(env, "EINVAL", "Buffer offset out of range");
        return NULL;
      }
      offset = (size_t)off_v;
      length = buf_len - offset;
    }
  }
  if (argc >= 4) {
    napi_valuetype t;
    if (napi_typeof(env, argv[3], &t) == napi_ok && t == napi_number) {
      int64_t len_v = 0;
      napi_get_value_int64(env, argv[3], &len_v);
      if (len_v < 0 || offset + (size_t)len_v > buf_len) {
        napi_throw_error(env, "EINVAL", "Buffer length out of range");
        return NULL;
      }
      length = (size_t)len_v;
    }
  }
  if (argc >= 5) {
    napi_valuetype t;
    if (napi_typeof(env, argv[4], &t) == napi_ok && t == napi_number) {
      napi_get_value_int64(env, argv[4], &position);
    }
  }

  uint8_t *ptr = (uint8_t *)buf_ptr + offset;

#ifdef _WIN32
  HANDLE h = NULL;
  bool is_dir = false;
  if (!lookup_win_slot(tok, &h, &is_dir) || is_dir) {
    napi_throw_error(env, "EBADF", "File handle is closed or is a directory");
    return NULL;
  }
  if (position >= 0) {
    LARGE_INTEGER li;
    li.QuadPart = position;
    if (!SetFilePointerEx(h, li, NULL, FILE_BEGIN)) {
      return throw_win_error(env, "readHandle(seek)", GetLastError());
    }
  }
  DWORD chunk = (length > 0x40000000) ? 0x40000000 : (DWORD)length;
  DWORD read_bytes = 0;
  if (!ReadFile(h, ptr, chunk, &read_bytes, NULL)) {
    return throw_win_error(env, "readHandle", GetLastError());
  }
  napi_value out;
  napi_create_int64(env, (int64_t)read_bytes, &out);
  return out;
#else
  int fd = -1;
  bool is_dir = false;
  if (!lookup_posix_slot(tok, &fd, &is_dir, NULL, NULL) || is_dir) {
    napi_throw_error(env, "EBADF", "File handle is closed or is a directory");
    return NULL;
  }
  ssize_t n;
  do {
    n = (position >= 0)
        ? pread(fd, ptr, length, (off_t)position)
        : read(fd, ptr, length);
  } while (n < 0 && errno == EINTR);
  if (n < 0) {
    return throw_posix_error(env, "readHandle", errno);
  }
  napi_value out;
  napi_create_int64(env, (int64_t)n, &out);
  return out;
#endif
}

/* fullFsync(handle) -> boolean (works on both file and directory handles) */
static napi_value fn_fullFsync(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1) {
    napi_throw_error(env, "EINVAL", "fullFsync requires handle");
    return NULL;
  }
  int64_t tok = 0;
  if (!get_handle_token(env, argv[0], &tok)) {
    napi_throw_error(env, "EBADF", "Invalid handle");
    return NULL;
  }

#ifdef _WIN32
  HANDLE h = NULL;
  if (!lookup_win_slot(tok, &h, NULL)) {
    napi_throw_error(env, "EBADF", "Handle is closed or invalid");
    return NULL;
  }
  if (!FlushFileBuffers(h)) {
    return throw_win_error(env, "fullFsync", GetLastError());
  }
  napi_value ok;
  napi_get_boolean(env, true, &ok);
  return ok;
#else
  int fd = -1;
  if (!lookup_posix_slot(tok, &fd, NULL, NULL, NULL)) {
    napi_throw_error(env, "EBADF", "Handle is closed or invalid");
    return NULL;
  }
#if defined(__APPLE__) && defined(F_FULLFSYNC)
  if (fcntl(fd, F_FULLFSYNC) != 0) {
    if (errno != ENOTSUP && errno != EINVAL) {
      return throw_posix_error(env, "fullFsync(F_FULLFSYNC)", errno);
    }
    if (fsync(fd) != 0) {
      return throw_posix_error(env, "fullFsync(fsync)", errno);
    }
  }
#else
  if (fsync(fd) != 0) {
    return throw_posix_error(env, "fullFsync", errno);
  }
#endif
  napi_value ok;
  napi_get_boolean(env, true, &ok);
  return ok;
#endif
}

/* unlinkAt(parentHandle, segment[, isDirectory]) -> boolean */
static napi_value fn_unlinkAt(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 2) {
    napi_throw_error(env, "EINVAL", "unlinkAt requires (parentHandle, segment)");
    return NULL;
  }
  int64_t parent_tok = 0;
  if (!get_handle_token(env, argv[0], &parent_tok)) {
    napi_throw_error(env, "EBADF", "Invalid parentHandle");
    return NULL;
  }
  char utf8_seg[512];
  size_t utf8_len = 0;
  if (!get_utf8_arg(env, argv[1], utf8_seg, sizeof(utf8_seg), &utf8_len)) {
    napi_throw_error(env, "EINVAL", "Invalid segment");
    return NULL;
  }
  bool is_dir = false;
  if (argc >= 3) {
    napi_get_value_bool(env, argv[2], &is_dir);
  }

#ifdef _WIN32
  ensure_ntdll();
  HANDLE parent_h = NULL;
  bool parent_is_dir = false;
  if (!lookup_win_slot(parent_tok, &parent_h, &parent_is_dir) || !parent_is_dir) {
    napi_throw_error(env, "EBADF", "Parent handle is closed or not a directory");
    return NULL;
  }
  wchar_t wseg[512];
  size_t wlen = 0;
  if (!get_utf16_arg(env, argv[1], wseg, 512, &wlen) ||
      !validate_segment_utf16(wseg, wlen, utf8_seg, utf8_len)) {
    return throw_win_error(env, "unlinkAt", ERROR_INVALID_NAME);
  }
  UNICODE_STRING us;
  us.Buffer = wseg;
  us.Length = (USHORT)(wlen * sizeof(WCHAR));
  us.MaximumLength = (USHORT)((wlen + 1) * sizeof(WCHAR));
  OBJECT_ATTRIBUTES oa;
  InitializeObjectAttributes(&oa, &us, OBJ_CASE_INSENSITIVE, parent_h, NULL);
  IO_STATUS_BLOCK io = {0};
  HANDLE h = NULL;
  ULONG opts = FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT |
               (is_dir ? FILE_DIRECTORY_FILE : FILE_NON_DIRECTORY_FILE);
  NTSTATUS st = pNtCreateFile(
      &h,
      DELETE | SYNCHRONIZE | FILE_READ_ATTRIBUTES,
      &oa,
      &io,
      NULL,
      FILE_ATTRIBUTE_NORMAL,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      FILE_OPEN,
      opts,
      NULL,
      0);
  if (st < 0) {
    DWORD dos = pRtlNtStatusToDosError(st);
    if ((dos == ERROR_DIRECTORY || dos == ERROR_ACCESS_DENIED) && win_is_reparse_point_rel(&oa)) {
      dos = ERROR_CANT_ACCESS_FILE;
    }
    return throw_win_error(env, "unlinkAt", dos);
  }
  FILE_ATTRIBUTE_TAG_INFO tag = {0};
  if (!GetFileInformationByHandleEx(h, FileAttributeTagInfo, &tag, sizeof(tag)) ||
      (tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
    CloseHandle(h);
    return throw_win_error(env, "unlinkAt", ERROR_CANT_ACCESS_FILE);
  }
  if (is_dir && (tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0) {
    CloseHandle(h);
    return throw_win_error(env, "unlinkAt", ERROR_DIRECTORY);
  }
  FILE_DISPOSITION_INFO disp = {0};
  disp.DeleteFile = TRUE;
  if (!SetFileInformationByHandle(h, FileDispositionInfo, &disp, sizeof(disp))) {
    DWORD derr = GetLastError();
    CloseHandle(h);
    return throw_win_error(env, "unlinkAt(dispose)", derr);
  }
  CloseHandle(h);
  napi_value ok;
  napi_get_boolean(env, true, &ok);
  return ok;
#else
  int parent_fd = -1;
  bool parent_is_dir = false;
  if (!lookup_posix_slot(parent_tok, &parent_fd, &parent_is_dir, NULL, NULL) || !parent_is_dir) {
    napi_throw_error(env, "EBADF", "Parent handle is closed or not a directory");
    return NULL;
  }
  if (!validate_segment_utf8(utf8_seg, utf8_len)) {
    napi_throw_error(env, "EINVAL", "Invalid segment in unlinkAt");
    return NULL;
  }
  struct stat st_unlink;
  if (fstatat(parent_fd, utf8_seg, &st_unlink, AT_SYMLINK_NOFOLLOW) != 0) {
    return throw_posix_error(env, "unlinkAt", normalize_posix_at_errno(parent_fd, utf8_seg, errno));
  }
  if (S_ISLNK(st_unlink.st_mode)) {
    napi_throw_error(env, "ELOOP", "unlinkAt refuses to unlink symbolic links");
    return NULL;
  }
  if (is_dir && !S_ISDIR(st_unlink.st_mode)) {
    return throw_posix_error(env, "unlinkAt", ENOTDIR);
  }
  if (!is_dir && S_ISDIR(st_unlink.st_mode)) {
    return throw_posix_error(env, "unlinkAt", EISDIR);
  }
  if (unlinkat(parent_fd, utf8_seg, is_dir ? AT_REMOVEDIR : 0) != 0) {
    return throw_posix_error(env, "unlinkAt", normalize_posix_at_errno(parent_fd, utf8_seg, errno));
  }
  napi_value ok;
  napi_get_boolean(env, true, &ok);
  return ok;
#endif
}

/* getIdentity(handle) -> { volumeId, fileId, fileIdLow, fileIdHigh, fileIdHex, linkCount, size, isDirectory, isReparsePoint, reparseTag } */
static napi_value fn_getIdentity(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1) {
    napi_throw_error(env, "EINVAL", "getIdentity requires handle");
    return NULL;
  }
  int64_t tok = 0;
  if (!get_handle_token(env, argv[0], &tok)) {
    napi_throw_error(env, "EBADF", "Invalid handle");
    return NULL;
  }

#ifdef _WIN32
  HANDLE h = NULL;
  if (!lookup_win_slot(tok, &h, NULL)) {
    napi_throw_error(env, "EBADF", "Handle is closed or invalid");
    return NULL;
  }
  FILE_ID_INFO id_info = {0};
  if (!GetFileInformationByHandleEx(h, FileIdInfo, &id_info, sizeof(id_info))) {
    return throw_win_error(env, "getIdentity(FileIdInfo)", GetLastError());
  }
  BY_HANDLE_FILE_INFORMATION bhfi = {0};
  if (!GetFileInformationByHandle(h, &bhfi)) {
    return throw_win_error(env, "getIdentity(ByHandle)", GetLastError());
  }
  FILE_ATTRIBUTE_TAG_INFO tag = {0};
  if (!GetFileInformationByHandleEx(h, FileAttributeTagInfo, &tag, sizeof(tag))) {
    return throw_win_error(env, "getIdentity(TagInfo)", GetLastError());
  }

  uint64_t words[2] = {0, 0};
  memcpy(&words[0], &id_info.FileId.Identifier[0], 8);
  memcpy(&words[1], &id_info.FileId.Identifier[8], 8);

  char hex[33];
  for (int i = 0; i < 16; i++) {
    snprintf(hex + (i * 2), 3, "%02x", (unsigned int)id_info.FileId.Identifier[i]);
  }
  hex[32] = '\0';

  uint64_t size_u64 = ((uint64_t)bhfi.nFileSizeHigh << 32) | (uint64_t)bhfi.nFileSizeLow;

  napi_value obj, v;
  napi_create_object(env, &obj);

  napi_create_bigint_uint64(env, (uint64_t)id_info.VolumeSerialNumber, &v);
  napi_set_named_property(env, obj, "volumeId", v);

  napi_create_bigint_words(env, 0, 2, words, &v);
  napi_set_named_property(env, obj, "fileId", v);

  napi_create_bigint_uint64(env, words[0], &v);
  napi_set_named_property(env, obj, "fileIdLow", v);

  napi_create_bigint_uint64(env, words[1], &v);
  napi_set_named_property(env, obj, "fileIdHigh", v);

  napi_create_string_utf8(env, hex, 32, &v);
  napi_set_named_property(env, obj, "fileIdHex", v);

  napi_create_uint32(env, (uint32_t)bhfi.nNumberOfLinks, &v);
  napi_set_named_property(env, obj, "linkCount", v);

  napi_create_bigint_uint64(env, size_u64, &v);
  napi_set_named_property(env, obj, "size", v);

  napi_get_boolean(env, (tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0, &v);
  napi_set_named_property(env, obj, "isDirectory", v);

  napi_get_boolean(env, (tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0, &v);
  napi_set_named_property(env, obj, "isReparsePoint", v);

  napi_create_uint32(env, (uint32_t)tag.ReparseTag, &v);
  napi_set_named_property(env, obj, "reparseTag", v);

  return obj;
#else
  int fd = -1;
  if (!lookup_posix_slot(tok, &fd, NULL, NULL, NULL)) {
    napi_throw_error(env, "EBADF", "Handle is closed or invalid");
    return NULL;
  }
  struct stat st;
  if (fstat(fd, &st) != 0) {
    return throw_posix_error(env, "getIdentity", errno);
  }
  uint64_t dev = (uint64_t)st.st_dev;
  uint64_t ino = (uint64_t)st.st_ino;
  char hex[33];
  snprintf(hex, sizeof(hex), "%016llx%016llx", (unsigned long long)ino, 0ULL);

  napi_value obj, v;
  napi_create_object(env, &obj);

  napi_create_bigint_uint64(env, dev, &v);
  napi_set_named_property(env, obj, "volumeId", v);

  napi_create_bigint_uint64(env, ino, &v);
  napi_set_named_property(env, obj, "fileId", v);

  napi_create_bigint_uint64(env, ino, &v);
  napi_set_named_property(env, obj, "fileIdLow", v);

  napi_create_bigint_uint64(env, 0, &v);
  napi_set_named_property(env, obj, "fileIdHigh", v);

  napi_create_string_utf8(env, hex, 32, &v);
  napi_set_named_property(env, obj, "fileIdHex", v);

  napi_create_uint32(env, (uint32_t)st.st_nlink, &v);
  napi_set_named_property(env, obj, "linkCount", v);

  napi_create_bigint_uint64(env, (uint64_t)st.st_size, &v);
  napi_set_named_property(env, obj, "size", v);

  napi_get_boolean(env, S_ISDIR(st.st_mode), &v);
  napi_set_named_property(env, obj, "isDirectory", v);

  napi_get_boolean(env, S_ISLNK(st.st_mode), &v);
  napi_set_named_property(env, obj, "isReparsePoint", v);

  napi_create_uint32(env, 0, &v);
  napi_set_named_property(env, obj, "reparseTag", v);

  return obj;
#endif
}

#ifndef _WIN32
static bool posix_probe_atomic_noreplace(int root_fd, const char *fs_name, uint64_t f_type) {
  if (g_test_fi.mode == TEST_FI_ATOMIC_RENAME_ERRNO) {
    int sim_err = g_test_fi.injected_errno;
    g_test_fi.mode = TEST_FI_NONE;
    if (posix_is_atomic_noreplace_unsupported_errno(sim_err) || sim_err == EINVAL) {
      return false;
    }
  }
#if defined(__APPLE__)
  (void)f_type;
  if (strcasecmp(fs_name, "nfs") == 0 ||
      strcasecmp(fs_name, "smbfs") == 0 ||
      strcasecmp(fs_name, "exfat") == 0 ||
      strcasecmp(fs_name, "msdos") == 0 ||
      strcasecmp(fs_name, "webdav") == 0 ||
      strcasecmp(fs_name, "afpfs") == 0) {
    return false;
  }
  struct {
    uint32_t length;
    vol_capabilities_attr_t caps;
  } vcb;
  struct attrlist al;
  memset(&al, 0, sizeof(al));
  memset(&vcb, 0, sizeof(vcb));
  al.bitmapcount = ATTR_BIT_MAP_COUNT;
  al.volattr = ATTR_VOL_INFO | ATTR_VOL_CAPABILITIES;
  if (fgetattrlist(root_fd, &al, &vcb, sizeof(vcb), 0) == 0 &&
      (vcb.caps.valid[VOL_CAPABILITIES_INTERFACES] & VOL_CAP_INT_RENAME_EXCL) != 0) {
    if ((vcb.caps.capabilities[VOL_CAPABILITIES_INTERFACES] & VOL_CAP_INT_RENAME_EXCL) == 0) {
      return false;
    }
  }
  if (renameatx_np(root_fd, ".adhdev-probe-nonexistent", root_fd, ".adhdev-probe-nonexistent", RENAME_EXCL) != 0) {
    int err = errno;
    if (posix_is_atomic_noreplace_unsupported_errno(err) || err == EINVAL) {
      return false;
    }
  }
  return true;
#elif defined(__linux__)
  (void)fs_name;
  /* Reject filesystems known not to provide atomic RENAME_NOREPLACE:
   * NFS (0x6969), MSDOS/FAT (0x4d44), SMB/CIFS/SMB2 (0x517b, 0xff534d42, 0xfe534d42),
   * exFAT (0x2011bab0), FUSE (0x65735546). */
  if (f_type == 0x6969ULL ||
      f_type == 0x4d44ULL ||
      f_type == 0x517bULL ||
      f_type == 0xff534d42ULL ||
      f_type == 0xfe534d42ULL ||
      f_type == 0x2011bab0ULL ||
      f_type == 0x65735546ULL) {
    return false;
  }
  if (syscall(
          SYS_renameat2,
          root_fd,
          ".adhdev-probe-nonexistent",
          root_fd,
          ".adhdev-probe-nonexistent",
          RENAME_NOREPLACE) != 0) {
    int err = errno;
    if (posix_is_atomic_noreplace_unsupported_errno(err) || err == EINVAL) {
      return false;
    }
  }
  return true;
#else
  (void)root_fd;
  (void)fs_name;
  (void)f_type;
  return false;
#endif
}
#endif

/* probeRoot(rootPath) -> { filesystem, volumeFlags, supports128BitFileId, supportsDirFullFsync, supportsAtomicNoReplace, caseSensitiveDir } */
static napi_value fn_probeRoot(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1) {
    napi_throw_error(env, "EINVAL", "probeRoot requires rootPath");
    return NULL;
  }

  char utf8_path[2048];
  size_t utf8_len = 0;
  if (!get_utf8_arg(env, argv[0], utf8_path, sizeof(utf8_path), &utf8_len) || utf8_len == 0) {
    napi_throw_error(env, "EINVAL", "Invalid rootPath");
    return NULL;
  }

#ifdef _WIN32
  ensure_ntdll();
  wchar_t wpath[1024];
  size_t wlen = 0;
  if (!get_utf16_arg(env, argv[0], wpath, 1024, &wlen) || wlen == 0) {
    napi_throw_error(env, "EINVAL", "Invalid UTF-16 rootPath");
    return NULL;
  }
  DWORD err = 0;
  HANDLE h = win_open_root_internal(wpath, &err);
  if (h == INVALID_HANDLE_VALUE) {
    return throw_win_error(env, "probeRoot", err);
  }
  wchar_t fs_name_w[64] = {0};
  DWORD vol_flags = 0;
  GetVolumeInformationByHandleW(h, NULL, 0, NULL, NULL, &vol_flags, fs_name_w, 64);
  char fs_name[128] = "UNKNOWN";
  WideCharToMultiByte(CP_UTF8, 0, fs_name_w, -1, fs_name, sizeof(fs_name), NULL, NULL);

  FILE_ID_INFO id_info = {0};
  bool has_128_id = GetFileInformationByHandleEx(h, FileIdInfo, &id_info, sizeof(id_info)) != 0;
  bool dir_fsync = FlushFileBuffers(h) != 0;
  bool atomic_noreplace = (pNtSetInformationFile != NULL) &&
                          (_stricmp(fs_name, "NTFS") == 0 || _stricmp(fs_name, "ReFS") == 0);
  if (g_test_fi.mode == TEST_FI_ATOMIC_RENAME_ERRNO) {
    g_test_fi.mode = TEST_FI_NONE;
    atomic_noreplace = false;
  }

  bool case_sensitive_dir = false;
  if (pNtQueryInformationFile) {
    IO_STATUS_BLOCK io = {0};
    ADHDEV_FILE_CASE_SENSITIVE_INFO csi = {0};
    NTSTATUS st = pNtQueryInformationFile(h, &io, &csi, sizeof(csi), 71 /* FileCaseSensitiveInformation */);
    if (st >= 0 && (csi.Flags & 1) != 0) {
      case_sensitive_dir = true;
    }
  }
  CloseHandle(h);

  napi_value obj, v;
  napi_create_object(env, &obj);
  napi_create_string_utf8(env, fs_name, NAPI_AUTO_LENGTH, &v);
  napi_set_named_property(env, obj, "filesystem", v);
  napi_create_uint32(env, (uint32_t)vol_flags, &v);
  napi_set_named_property(env, obj, "volumeFlags", v);
  napi_get_boolean(env, has_128_id, &v);
  napi_set_named_property(env, obj, "supports128BitFileId", v);
  napi_get_boolean(env, dir_fsync, &v);
  napi_set_named_property(env, obj, "supportsDirFullFsync", v);
  napi_get_boolean(env, atomic_noreplace, &v);
  napi_set_named_property(env, obj, "supportsAtomicNoReplace", v);
  napi_get_boolean(env, case_sensitive_dir, &v);
  napi_set_named_property(env, obj, "caseSensitiveDir", v);
  return obj;
#else
  int err = 0;
  int fd = posix_open_root_fd(utf8_path, NULL, &err);
  if (fd < 0) {
    return throw_posix_error(env, "probeRoot", err);
  }
  char fs_name[64] = "posix";
  uint32_t vol_flags = 0;
  uint64_t f_type = 0;
#if defined(__APPLE__)
  struct statfs sfs;
  if (fstatfs(fd, &sfs) == 0) {
    strncpy(fs_name, sfs.f_fstypename, sizeof(fs_name) - 1);
    vol_flags = (uint32_t)sfs.f_flags;
  }
#elif defined(__linux__)
  struct statfs sfs;
  if (fstatfs(fd, &sfs) == 0) {
    f_type = (uint64_t)sfs.f_type;
    snprintf(fs_name, sizeof(fs_name), "linux-0x%lx", (unsigned long)sfs.f_type);
    vol_flags = (uint32_t)sfs.f_flags;
  }
#endif
  bool atomic_noreplace = posix_probe_atomic_noreplace(fd, fs_name, f_type);
  bool dir_fsync = (fsync(fd) == 0);
  close(fd);

  napi_value obj, v;
  napi_create_object(env, &obj);
  napi_create_string_utf8(env, fs_name, NAPI_AUTO_LENGTH, &v);
  napi_set_named_property(env, obj, "filesystem", v);
  napi_create_uint32(env, vol_flags, &v);
  napi_set_named_property(env, obj, "volumeFlags", v);
  napi_get_boolean(env, true, &v);
  napi_set_named_property(env, obj, "supports128BitFileId", v);
  napi_get_boolean(env, dir_fsync, &v);
  napi_set_named_property(env, obj, "supportsDirFullFsync", v);
  napi_get_boolean(env, atomic_noreplace, &v);
  napi_set_named_property(env, obj, "supportsAtomicNoReplace", v);
  napi_get_boolean(env, false, &v);
  napi_set_named_property(env, obj, "caseSensitiveDir", v);
  return obj;
#endif
}

/* close(handle) -> boolean (idempotent on already-closed handle token) */
static napi_value fn_close(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1) {
    napi_throw_error(env, "EINVAL", "close requires handle");
    return NULL;
  }
  int64_t tok = 0;
  int slot = 0;
  uint32_t gen = 0;
  if (!get_handle_token(env, argv[0], &tok) || !parse_token(tok, &slot, &gen)) {
    napi_throw_error(env, "EBADF", "Invalid handle token");
    return NULL;
  }

#ifdef _WIN32
  HANDLE h = NULL;
  LOCK_SLOTS();
  if (g_slots[slot].active && g_slots[slot].generation == gen) {
    h = g_slots[slot].h;
    g_slots[slot].active = false;
    g_slots[slot].h = NULL;
  }
  UNLOCK_SLOTS();
  if (h) {
    CloseHandle(h);
  }
  napi_value out;
  napi_get_boolean(env, h != NULL, &out);
  return out;
#else
  int fd = -1;
  LOCK_SLOTS();
  if (g_slots[slot].active && g_slots[slot].generation == gen) {
    fd = g_slots[slot].fd;
    g_slots[slot].active = false;
    g_slots[slot].fd = -1;
  }
  UNLOCK_SLOTS();
  if (fd >= 0) {
    close(fd);
  }
  napi_value out;
  napi_get_boolean(env, fd >= 0, &out);
  return out;
#endif
}

/* configureTestFaultInjection(modeOrNull[, auxOrErrno]) -> boolean */
static napi_value fn_configureTestFaultInjection(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1) {
    g_test_fi.mode = TEST_FI_NONE;
    g_test_fi.injected_errno = 0;
    g_test_fi.aux_name[0] = '\0';
    napi_value ok;
    napi_get_boolean(env, true, &ok);
    return ok;
  }
  napi_valuetype t0;
  napi_typeof(env, argv[0], &t0);
  if (t0 == napi_null || t0 == napi_undefined) {
    g_test_fi.mode = TEST_FI_NONE;
    g_test_fi.injected_errno = 0;
    g_test_fi.aux_name[0] = '\0';
    napi_value ok;
    napi_get_boolean(env, true, &ok);
    return ok;
  }
  char mode_str[128] = {0};
  if (!get_utf8_arg(env, argv[0], mode_str, sizeof(mode_str), NULL)) {
    napi_throw_error(env, "EINVAL", "Invalid fault injection mode");
    return NULL;
  }
  g_test_fi.injected_errno = 0;
  g_test_fi.aux_name[0] = '\0';
  if (strcmp(mode_str, "swap_src_before_rename") == 0) {
    if (argc < 2 || !get_utf8_arg(env, argv[1], g_test_fi.aux_name, sizeof(g_test_fi.aux_name), NULL)) {
      napi_throw_error(env, "EINVAL", "swap_src_before_rename requires auxName");
      return NULL;
    }
    g_test_fi.mode = TEST_FI_SWAP_SRC_BEFORE_RENAME;
  } else if (strcmp(mode_str, "replace_dst_after_rename") == 0) {
    if (argc < 2 || !get_utf8_arg(env, argv[1], g_test_fi.aux_name, sizeof(g_test_fi.aux_name), NULL)) {
      napi_throw_error(env, "EINVAL", "replace_dst_after_rename requires auxName");
      return NULL;
    }
    g_test_fi.mode = TEST_FI_REPLACE_DST_AFTER_RENAME;
  } else if (strcmp(mode_str, "hardlink_after_rename") == 0) {
    if (argc < 2 || !get_utf8_arg(env, argv[1], g_test_fi.aux_name, sizeof(g_test_fi.aux_name), NULL)) {
      napi_throw_error(env, "EINVAL", "hardlink_after_rename requires auxName");
      return NULL;
    }
    g_test_fi.mode = TEST_FI_HARDLINK_AFTER_RENAME;
  } else if (strcmp(mode_str, "atomic_rename_errno") == 0) {
    char err_name[64] = {0};
    if (argc < 2 || !get_utf8_arg(env, argv[1], err_name, sizeof(err_name), NULL)) {
      napi_throw_error(env, "EINVAL", "atomic_rename_errno requires errno name");
      return NULL;
    }
#ifdef _WIN32
    if (strcmp(err_name, "ENOSYS") == 0) g_test_fi.injected_errno = (int)ERROR_CALL_NOT_IMPLEMENTED;
    else if (strcmp(err_name, "ENOTSUP") == 0 || strcmp(err_name, "EOPNOTSUPP") == 0) g_test_fi.injected_errno = (int)ERROR_NOT_SUPPORTED;
    else if (strcmp(err_name, "EINVAL") == 0) g_test_fi.injected_errno = (int)ERROR_INVALID_FUNCTION;
    else g_test_fi.injected_errno = (int)ERROR_NOT_SUPPORTED;
#else
    if (strcmp(err_name, "ENOSYS") == 0) g_test_fi.injected_errno = ENOSYS;
    else if (strcmp(err_name, "ENOTSUP") == 0) g_test_fi.injected_errno = ENOTSUP;
#ifdef EOPNOTSUPP
    else if (strcmp(err_name, "EOPNOTSUPP") == 0) g_test_fi.injected_errno = EOPNOTSUPP;
#endif
    else if (strcmp(err_name, "EINVAL") == 0) g_test_fi.injected_errno = EINVAL;
    else g_test_fi.injected_errno = ENOTSUP;
#endif
    g_test_fi.mode = TEST_FI_ATOMIC_RENAME_ERRNO;
  } else {
    napi_throw_error(env, "EINVAL", "Unknown fault injection mode");
    return NULL;
  }
  napi_value ok;
  napi_get_boolean(env, true, &ok);
  return ok;
}

#define EXPORT_FN(name, fn)                                           \
  do {                                                                \
    napi_value f;                                                     \
    napi_create_function(env, name, NAPI_AUTO_LENGTH, fn, NULL, &f);  \
    napi_set_named_property(env, exports, name, f);                   \
  } while (0)

NAPI_MODULE_INIT() {
  EXPORT_FN("getBindingInfo", fn_getBindingInfo);
  EXPORT_FN("openRoot", fn_openRoot);
  EXPORT_FN("walkDir", fn_walkDir);
  EXPORT_FN("mkdirExcl", fn_mkdirExcl);
  EXPORT_FN("createExcl", fn_createExcl);
  EXPORT_FN("openFileRead", fn_openFileRead);
  EXPORT_FN("renameExcl", fn_renameExcl);
  EXPORT_FN("renameAtExcl", fn_renameAtExcl);
  EXPORT_FN("writeHandle", fn_writeHandle);
  EXPORT_FN("readHandle", fn_readHandle);
  EXPORT_FN("fullFsync", fn_fullFsync);
  EXPORT_FN("unlinkAt", fn_unlinkAt);
  EXPORT_FN("getIdentity", fn_getIdentity);
  EXPORT_FN("probeRoot", fn_probeRoot);
  EXPORT_FN("close", fn_close);
  EXPORT_FN("configureTestFaultInjection", fn_configureTestFaultInjection);
  return exports;
}
