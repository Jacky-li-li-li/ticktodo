#!/usr/bin/env bash
# Tick 一键安装脚本： curl -fsSL https://ticktodo.cc/install.sh | bash
set -euo pipefail

REPO="Jacky-li-li-li/ticktodo"
API="https://api.github.com/repos/${REPO}/releases/latest"
RELEASES_PAGE="https://github.com/${REPO}/releases"

err() { printf '错误：%s\n' "$*" >&2; exit 1; }
info() { printf '==> %s\n' "$*"; }

[ "$(uname -s)" = "Darwin" ] || err "Tick 目前仅支持 macOS（检测到 $(uname -s)）。"

case "$(uname -m)" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64) ARCH="x64" ;;
  *) err "不支持的 CPU 架构：$(uname -m)" ;;
esac
# 在 Rosetta 终端里 uname -m 会显示 x86_64，这里纠正为真实架构
if [ "$ARCH" = "x64" ] && [ "$(sysctl -in sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
  ARCH="arm64"
fi

command -v curl >/dev/null 2>&1 || err "需要 curl。"
command -v unzip >/dev/null 2>&1 || err "需要 unzip。"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

info "查询最新版本…"
HTTP="$(curl -sSL -o "$TMP/release.json" -w '%{http_code}' -H 'Accept: application/vnd.github+json' "$API" || true)"
if [ "$HTTP" != "200" ]; then
  err "没有找到已发布的版本（HTTP ${HTTP:-000}）。请稍后再试，或访问 ${RELEASES_PAGE}"
fi

# 取出所有 .zip / .dmg 资源下载地址
URLS="$(grep -o '"browser_download_url": *"[^"]*"' "$TMP/release.json" | sed 's/.*"\(https[^"]*\)"$/\1/' | grep -Ei '\.(zip|dmg)$' || true)"
[ -n "$URLS" ] || err "最新版本中没有可用的 macOS 安装包。请访问 ${RELEASES_PAGE}"

pick() { printf '%s\n' "$URLS" | grep -Ei "$1" | head -n 1 || true; }

if [ "$ARCH" = "arm64" ]; then
  ARCH_RE='(arm64|aarch64)'
else
  ARCH_RE='(x64|x86_64|amd64|intel)'
fi

ASSET="$(pick "${ARCH_RE}.*\\.zip\$")"
[ -n "$ASSET" ] || ASSET="$(pick "${ARCH_RE}.*\\.dmg\$")"
if [ -z "$ASSET" ] && [ "$ARCH" = "x64" ]; then
  # 没有带架构标记的 zip 通常是 x64 构建；排除 arm64
  ASSET="$(printf '%s\n' "$URLS" | grep -Ei '\.zip$' | grep -Eiv '(arm64|aarch64)' | head -n 1 || true)"
fi
if [ -z "$ASSET" ] && [ "$ARCH" = "arm64" ]; then
  # Apple Silicon 可回退到任意 mac 包（含 x64，经 Rosetta 运行）
  ASSET="$(pick '(mac|darwin|osx).*\.zip$')"
  [ -n "$ASSET" ] || ASSET="$(pick '\.zip$')"
  [ -n "$ASSET" ] || ASSET="$(pick '\.dmg$')"
fi
[ -n "$ASSET" ] || err "没有找到适用于 macOS 的安装包。请访问 ${RELEASES_PAGE}"

FILE="$TMP/$(basename "$ASSET")"
info "下载 $(basename "$ASSET")…"
curl -fL --progress-bar -o "$FILE" "$ASSET" || err "下载失败：$ASSET"

APP_SRC=""
case "$FILE" in
  *.zip)
    mkdir -p "$TMP/x"
    unzip -q "$FILE" -d "$TMP/x" || err "解压失败。"
    ;;
  *.dmg)
    command -v hdiutil >/dev/null 2>&1 || err "需要 hdiutil。"
    MNT="$TMP/mnt"; mkdir -p "$MNT"
    hdiutil attach -nobrowse -readonly -quiet -mountpoint "$MNT" "$FILE" || err "挂载 dmg 失败。"
    mkdir -p "$TMP/x"
    cp -R "$MNT"/*.app "$TMP/x/" || { hdiutil detach -quiet "$MNT" || true; err "dmg 中没有找到 .app。"; }
    hdiutil detach -quiet "$MNT" || true
    ;;
esac

if [ -d "$TMP/x/Tick.app" ]; then
  APP_SRC="$TMP/x/Tick.app"
else
  APP_SRC="$(find "$TMP/x" -maxdepth 3 -name '*.app' -type d | head -n 1)"
fi
[ -n "$APP_SRC" ] || err "安装包中没有找到 .app。"
APP_NAME="$(basename "$APP_SRC")"

if [ -d /Applications ] && [ -w /Applications ]; then
  DEST_DIR="/Applications"
else
  DEST_DIR="$HOME/Applications"
  mkdir -p "$DEST_DIR"
fi
DEST="$DEST_DIR/$APP_NAME"

if [ -e "$DEST" ]; then
  info "替换已有的 $DEST"
  rm -rf "$DEST"
fi
mv "$APP_SRC" "$DEST" 2>/dev/null || cp -R "$APP_SRC" "$DEST"

# 应用未签名：移除隔离属性，避免“已损坏 / 无法验证开发者”提示
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

printf '\n✅ Tick 安装完成！\n   位置：%s\n   打开方式：在启动台 / 访达中打开「%s」，或在终端运行：open "%s"\n   Tick 是菜单栏应用，启动后请在屏幕顶部菜单栏查找它的图标。\n' "$DEST" "${APP_NAME%.app}" "$DEST"
