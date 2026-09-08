#include <dlfcn.h>
#include <fcntl.h>
#include <stdarg.h>
#include <sys/syscall.h>
#include <unistd.h>

#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>

namespace {

constexpr char kPackageSuffix[] = "resources/app/package.json";
constexpr char kLoadScriptSuffix[] = "resources/app/loadNapCat.js";
constexpr char kLoadScript[] =
    "(async () => {"
    "const { pathToFileURL } = await import('node:url');"
    "const mainPath = process.env.NAPCAT_MAIN_PATH;"
    "if (!mainPath) throw new Error('NAPCAT_MAIN_PATH is not set');"
    "await import(pathToFileURL(mainPath).href);"
    "})()";

using Open64Fn = int (*)(const char *, int, ...);
using Fopen64Fn = FILE *(*)(const char *, const char *);

Open64Fn g_open64 = nullptr;
Fopen64Fn g_fopen64 = nullptr;

__attribute__((constructor)) void resolve_symbols() {
  g_open64 = reinterpret_cast<Open64Fn>(dlsym(RTLD_NEXT, "open64"));
  g_fopen64 = reinterpret_cast<Fopen64Fn>(dlsym(RTLD_NEXT, "fopen64"));
}

bool ends_with(const char *path, const char *suffix) {
  if (!path || !suffix) return false;
  const size_t path_length = std::strlen(path);
  const size_t suffix_length = std::strlen(suffix);
  return path_length >= suffix_length && std::strcmp(path + path_length - suffix_length, suffix) == 0;
}

char *read_patch_package() {
  const char *patch_path = std::getenv("NAPCAT_PATCH_PACKAGE");
  if (!patch_path || !*patch_path || !g_fopen64) return nullptr;

  FILE *file = g_fopen64(patch_path, "rb");
  if (!file) return nullptr;

  if (std::fseek(file, 0, SEEK_END) != 0) {
    std::fclose(file);
    return nullptr;
  }
  const long size = std::ftell(file);
  if (size < 0 || std::fseek(file, 0, SEEK_SET) != 0) {
    std::fclose(file);
    return nullptr;
  }

  auto *content = static_cast<char *>(std::malloc(static_cast<size_t>(size) + 1));
  if (!content) {
    std::fclose(file);
    return nullptr;
  }

  const size_t bytes_read = std::fread(content, 1, static_cast<size_t>(size), file);
  std::fclose(file);
  if (bytes_read != static_cast<size_t>(size)) {
    std::free(content);
    return nullptr;
  }
  content[bytes_read] = '\0';
  return content;
}

int create_memfd(const char *content) {
  const int fd = static_cast<int>(syscall(SYS_memfd_create, "napcat-launcher", 0));
  if (fd < 0) return -1;

  const size_t length = std::strlen(content);
  size_t written = 0;
  while (written < length) {
    const ssize_t result = write(fd, content + written, length - written);
    if (result <= 0) {
      close(fd);
      return -1;
    }
    written += static_cast<size_t>(result);
  }

  if (lseek(fd, 0, SEEK_SET) == -1) {
    close(fd);
    return -1;
  }
  return fd;
}

int open_virtual_file(const char *path) {
  if (ends_with(path, kLoadScriptSuffix)) return create_memfd(kLoadScript);
  if (!ends_with(path, kPackageSuffix)) return -1;

  char *package = read_patch_package();
  if (!package) {
    const char *patch_path = std::getenv("NAPCAT_PATCH_PACKAGE");
    std::fprintf(stderr, "napcat-linux-launcher: cannot read NAPCAT_PATCH_PACKAGE: %s\n",
                 patch_path ? patch_path : "<unset>");
    errno = ENOENT;
    return -2;
  }

  const int fd = create_memfd(package);
  std::free(package);
  return fd >= 0 ? fd : -2;
}

}  // namespace

extern "C" int open64(const char *path, int flags, ...) {
  const int virtual_fd = open_virtual_file(path);
  if (virtual_fd >= 0) return virtual_fd;
  if (virtual_fd == -2) return -1;

  if (!g_open64) {
    errno = ENOSYS;
    return -1;
  }

  bool has_mode = (flags & O_CREAT) != 0;
#ifdef O_TMPFILE
  has_mode = has_mode || (flags & O_TMPFILE) == O_TMPFILE;
#endif
  if (has_mode) {
    va_list args;
    va_start(args, flags);
    const mode_t mode = va_arg(args, mode_t);
    va_end(args);
    return g_open64(path, flags, mode);
  }
  return g_open64(path, flags);
}

extern "C" FILE *fopen64(const char *path, const char *mode) {
  const int virtual_fd = open_virtual_file(path);
  if (virtual_fd >= 0) {
    FILE *file = fdopen(virtual_fd, mode);
    if (!file) close(virtual_fd);
    return file;
  }
  if (virtual_fd == -2) return nullptr;

  if (!g_fopen64) {
    errno = ENOSYS;
    return nullptr;
  }
  return g_fopen64(path, mode);
}
