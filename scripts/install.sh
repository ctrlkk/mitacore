#!/usr/bin/env bash

# 仅安装 Linux QQ 与图形运行依赖；NapCat 的下载、配置和启动由应用内 loader.ts 负责。
set -euo pipefail

QQ_SIGN_URL='https://im.qq.com/http2rpc/gotrpc/noauth/trpc.qqntv2.urlsign.UrlSign/GetSign'

run_as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    printf '需要 root 权限或 sudo 来安装系统软件包。\n' >&2
    exit 1
  fi
}

if command -v apt-get >/dev/null 2>&1; then
  package_manager='apt-get'
  package_format='deb'
elif command -v dnf >/dev/null 2>&1; then
  package_manager='dnf'
  package_format='rpm'
else
  printf '不支持当前系统：仅支持使用 apt-get 或 dnf 的 Linux 发行版。\n' >&2
  exit 1
fi

case "$(uname -m)" in
  x86_64 | amd64)
    if [ "$package_format" = 'deb' ]; then
      qq_url='https://qqdl.gtimg.cn/qqfile/QQNTV2/9.9.35/release/1763096b/QQ_3.2.33_260902_amd64_01.deb'
    else
      qq_url='https://qqdl.gtimg.cn/qqfile/QQNTV2/9.9.35/release/1763096b/QQ_3.2.33_260902_x86_64_01.rpm'
    fi
    ;;
  aarch64 | arm64)
    if [ "$package_format" = 'deb' ]; then
      qq_url='https://qqdl.gtimg.cn/qqfile/QQNTV2/9.9.35/release/1763096b/QQ_3.2.33_260902_arm64_01.deb'
    else
      qq_url='https://qqdl.gtimg.cn/qqfile/QQNTV2/9.9.35/release/1763096b/QQ_3.2.33_260902_aarch64_01.rpm'
    fi
    ;;
  *)
    printf '不支持的 CPU 架构：%s\n' "$(uname -m)" >&2
    exit 1
    ;;
esac

printf '使用 %s 安装运行依赖...\n' "$package_manager"
if [ "$package_manager" = 'apt-get' ]; then
  run_as_root apt-get update
  run_as_root apt-get install -y --no-install-recommends ca-certificates curl jq xvfb xauth
else
  run_as_root dnf install -y ca-certificates curl jq xorg-x11-server-Xvfb xorg-x11-xauth
fi

if [ -x /opt/QQ/qq ]; then
  printf '已检测到 Linux QQ：/opt/QQ/qq\n'
  printf '环境准备完成。NapCat 将在应用首次启动时自动下载并配置。\n'
  exit 0
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
chmod 755 "$tmp_dir"
qq_package="$tmp_dir/QQ.$package_format"

printf '下载 Linux QQ（%s，%s）...\n' "$(uname -m)" "$package_format"
qq_sign_payload="$(jq -cn --arg url "$qq_url" '{url: $url}')"
qq_signed_url="$(curl --fail --location --retry 3 --retry-delay 2 "$QQ_SIGN_URL" \
  --header 'Content-Type: application/json' \
  --header 'x-oidb: {"uint32_command":"0x9b8e","uint32_service_type":1}' \
  --data-binary "$qq_sign_payload" | jq -er 'select(.retcode == 0) | .data.url')"
curl --fail --location --retry 3 --retry-delay 2 --output "$qq_package" "$qq_signed_url"

printf '安装 Linux QQ...\n'
if [ "$package_manager" = 'apt-get' ]; then
  run_as_root apt-get install -y --allow-downgrades "$qq_package"
else
  run_as_root dnf install -y --allowerasing "$qq_package"
fi

if [ ! -x /opt/QQ/qq ]; then
  printf 'Linux QQ 安装完成，但未找到可执行文件：/opt/QQ/qq\n' >&2
  exit 1
fi

printf '环境准备完成。NapCat 将在应用首次启动时自动下载并配置。\n'
