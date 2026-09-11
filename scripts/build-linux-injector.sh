#!/usr/bin/env bash

# 在目标 Linux 主机上编译 NapCat 注入器，以匹配当前 CPU 架构和 libc。
set -euo pipefail

if [ "$(uname -s)" != 'Linux' ]; then
  printf 'NapCat 注入器仅支持 Linux，当前系统：%s\n' "$(uname -s)" >&2
  exit 1
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
root_dir="$(cd -- "$script_dir/.." && pwd)"
source_path="$root_dir/scripts/launcher.c"
output_path="${1:-$root_dir/bin/libnapcat_launcher.so}"

if [ ! -f "$source_path" ]; then
  printf '未找到注入器源码：%s\n' "$source_path" >&2
  exit 1
fi

if [ -n "${CC:-}" ]; then
  compiler="$CC"
elif command -v cc >/dev/null 2>&1; then
  compiler='cc'
elif command -v gcc >/dev/null 2>&1; then
  compiler='gcc'
elif command -v clang >/dev/null 2>&1; then
  compiler='clang'
else
  printf '未找到 C 编译器，请安装 gcc 或 clang，或通过 CC 指定编译器。\n' >&2
  exit 1
fi

output_dir="$(dirname -- "$output_path")"
mkdir -p "$output_dir"
temporary_output="$output_path.tmp.$$"
trap 'rm -f "$temporary_output"' EXIT

printf '使用 %s 为 Linux %s 编译 NapCat 注入器...\n' "$compiler" "$(uname -m)"
"$compiler" \
  -std=c11 \
  -O2 \
  -Wall \
  -Wextra \
  -Werror \
  -fPIC \
  -shared \
  "$source_path" \
  -o "$temporary_output" \
  -ldl
mv -f "$temporary_output" "$output_path"
chmod 755 "$output_path"

printf 'NapCat 注入器已生成：%s\n' "$output_path"
