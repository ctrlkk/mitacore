#define _GNU_SOURCE

#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <unistd.h>

static const char k_package_suffix[] = "resources/app/package.json";

typedef int (*open64_fn)(const char *, int, ...);
typedef FILE *(*fopen64_fn)(const char *, const char *);

static open64_fn g_open64 = NULL;
static fopen64_fn g_fopen64 = NULL;

__attribute__((constructor)) static void resolve_symbols(void) {
  g_open64 = (open64_fn)dlsym(RTLD_NEXT, "open64");
  g_fopen64 = (fopen64_fn)dlsym(RTLD_NEXT, "fopen64");
}

static int ends_with(const char *path, const char *suffix) {
  size_t path_length;
  size_t suffix_length;

  if (!path || !suffix) return 0;
  path_length = strlen(path);
  suffix_length = strlen(suffix);
  return path_length >= suffix_length && strcmp(path + path_length - suffix_length, suffix) == 0;
}

static char *read_patch_package(void) {
  const char *patch_path = getenv("NAPCAT_PATCH_PACKAGE");
  FILE *file;
  long size;
  char *content;
  size_t bytes_read;

  if (!patch_path || !*patch_path || !g_fopen64) return NULL;

  file = g_fopen64(patch_path, "rb");
  if (!file) return NULL;

  if (fseek(file, 0, SEEK_END) != 0) {
    fclose(file);
    return NULL;
  }
  size = ftell(file);
  if (size < 0 || fseek(file, 0, SEEK_SET) != 0) {
    fclose(file);
    return NULL;
  }

  content = malloc((size_t)size + 1);
  if (!content) {
    fclose(file);
    return NULL;
  }

  bytes_read = fread(content, 1, (size_t)size, file);
  fclose(file);
  if (bytes_read != (size_t)size) {
    free(content);
    return NULL;
  }
  content[bytes_read] = '\0';
  return content;
}

static int create_memfd(const char *content) {
  int fd = (int)syscall(SYS_memfd_create, "napcat-launcher", 0);
  size_t length;
  size_t written = 0;

  if (fd < 0) return -1;

  length = strlen(content);
  while (written < length) {
    ssize_t result = write(fd, content + written, length - written);
    if (result < 0 && errno == EINTR) continue;
    if (result <= 0) {
      close(fd);
      return -1;
    }
    written += (size_t)result;
  }

  if (lseek(fd, 0, SEEK_SET) == -1) {
    close(fd);
    return -1;
  }
  return fd;
}

static int open_patch_package(const char *path) {
  char *package;
  int fd;

  if (!ends_with(path, k_package_suffix)) return -1;

  package = read_patch_package();
  if (!package) {
    const char *patch_path = getenv("NAPCAT_PATCH_PACKAGE");
    fprintf(stderr, "napcat-linux-launcher: cannot read NAPCAT_PATCH_PACKAGE: %s\n",
            patch_path ? patch_path : "<unset>");
    errno = ENOENT;
    return -2;
  }

  fd = create_memfd(package);
  free(package);
  return fd >= 0 ? fd : -2;
}

int open64(const char *path, int flags, ...) {
  int virtual_fd = open_patch_package(path);
  int has_mode;

  if (virtual_fd >= 0) return virtual_fd;
  if (virtual_fd == -2) return -1;

  if (!g_open64) {
    errno = ENOSYS;
    return -1;
  }

  has_mode = (flags & O_CREAT) != 0;
#ifdef O_TMPFILE
  has_mode = has_mode || (flags & O_TMPFILE) == O_TMPFILE;
#endif
  if (has_mode) {
    va_list args;
    mode_t mode;

    va_start(args, flags);
    mode = va_arg(args, mode_t);
    va_end(args);
    return g_open64(path, flags, mode);
  }
  return g_open64(path, flags);
}

FILE *fopen64(const char *path, const char *mode) {
  int virtual_fd = open_patch_package(path);

  if (virtual_fd >= 0) {
    FILE *file = fdopen(virtual_fd, mode);
    if (!file) close(virtual_fd);
    return file;
  }
  if (virtual_fd == -2) return NULL;

  if (!g_fopen64) {
    errno = ENOSYS;
    return NULL;
  }
  return g_fopen64(path, mode);
}
