#!/usr/bin/env bash

# 仅准备 Linux QQ 与图形运行依赖；NapCat Shell 的下载、配置和启动由应用内 loader.ts 负责。
set -euo pipefail

QQ_INSTALL_ROOT="${QQ_INSTALL_ROOT:-$HOME}"
QQ_EXECUTABLE="$QQ_INSTALL_ROOT/opt/QQ/qq"
QQ_CONFIG_URL='https://qq-web.cdn-go.cn/im.qq.com_new/latest/rainbow/pcConfig.json'
QQ_SIGN_URL='https://im.qq.com/http2rpc/gotrpc/noauth/trpc.qqntv2.urlsign.UrlSign/GetSign'
QQ_DOWNLOAD_URL="${QQ_DOWNLOAD_URL:-}"

log() {
  printf '[napcat-install] %s\n' "$*"
}

run_as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    printf '需要 root 权限或 sudo 来安装系统依赖。\n' >&2
    exit 1
  fi
}

if ! command -v apt-get >/dev/null 2>&1; then
  printf '此脚本仅支持 Debian/Ubuntu（未找到 apt-get）。\n' >&2
  exit 1
fi

case "$(dpkg --print-architecture)" in
  arm64)
    qq_download_query='.Linux.armDownloadUrl.deb'
    ;;
  amd64)
    qq_download_query='.Linux.x64DownloadUrl.deb'
    ;;
  *)
    printf '不支持的 CPU 架构：%s\n' "$(dpkg --print-architecture)" >&2
    exit 1
    ;;
esac

if [ -e "$QQ_EXECUTABLE" ]; then
  log "已检测到 Linux QQ：$QQ_EXECUTABLE"
  exit 0
fi

if [ -e "$QQ_INSTALL_ROOT/opt/QQ" ]; then
  printf 'QQ 安装目录已存在但缺少可执行文件：%s\n' "$QQ_INSTALL_ROOT/opt/QQ" >&2
  printf '请确认目录内容后手动清理，避免覆盖现有数据。\n' >&2
  exit 1
fi

log '安装 Linux QQ 运行依赖...'
run_as_root apt-get update

# Ubuntu 24.04+ 将 ALSA ABI 包迁移为 libasound2t64；旧版 Debian/Ubuntu 仍使用原包名。
alsa_package='libasound2'
if apt-cache show libasound2t64 >/dev/null 2>&1; then
  alsa_package='libasound2t64'
fi

run_as_root apt-get install -y --no-install-recommends \
  ca-certificates curl jq xvfb xauth libgcrypt20 libnss3 libgbm1 libglib2.0-0 libatk1.0-0 libatspi2.0-0 libgtk-3-0 "$alsa_package"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
qq_package="$tmp_dir/QQ.deb"

# QQ CDN 要求短时签名 URL；官网提供无登录的签名接口。
qq_url="$QQ_DOWNLOAD_URL"
if [ -z "$qq_url" ]; then
  qq_base_url="$(curl --fail --location --retry 3 --retry-delay 2 "$QQ_CONFIG_URL" | jq -er "$qq_download_query")"
  qq_sign_payload="$(jq -cn --arg url "$qq_base_url" '{url: $url}')"
  qq_url="$(curl --fail --location --retry 3 --retry-delay 2 "$QQ_SIGN_URL" \
    --header 'Content-Type: application/json' \
    --header 'x-oidb: {"uint32_command":"0x9b8e","uint32_service_type":1}' \
    --data-binary "$qq_sign_payload" | jq -er 'select(.retcode == 0) | .data.url')"
fi

log "下载 Linux QQ（$(dpkg --print-architecture)）..."
curl --fail --location --retry 3 --retry-delay 2 --output "$qq_package" "$qq_url"

log "解压 Linux QQ 到 $QQ_INSTALL_ROOT/opt/QQ..."
mkdir -p "$QQ_INSTALL_ROOT"
dpkg-deb --extract "$qq_package" "$QQ_INSTALL_ROOT"
chmod +x "$QQ_EXECUTABLE"

log '环境准备完成。NapCat 将在应用首次启动时由 loader.ts 自动下载并配置。'
