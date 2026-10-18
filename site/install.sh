#!/bin/sh
# Tick 安装脚本（唯一版本；site/install.sh 是它的逐字节拷贝）
#
# 一行安装（装最新 Release，校验 SHA256SUMS.txt）：
#   curl -fsSL https://raw.githubusercontent.com/Jacky-li-li-li/ticktodo/main/scripts/install.sh | sh
#   curl -fsSL https://ticktodo.cc/install.sh | sh
#
# 本地用法：
#   scripts/install.sh                    # 同上，装最新 Release
#   scripts/install.sh path/to/Tick.app   # 直接安装本地 .app（本地构建，不联网）
#   scripts/install.sh path/to/Tick.dmg   # 直接安装本地 dmg（不校验）
# 环境变量：TICK_VERSION=0.1.0 指定版本（默认取 releases/latest）
#
# 流程（release-playbook §6.2）：取版本 → 下载 dmg → 校验 sha256 → hdiutil attach
#   → 退出旧实例并替换 → hdiutil detach → trap 清理临时目录。
set -eu

REPO="Jacky-li-li-li/ticktodo"
RELEASES="https://github.com/${REPO}/releases"

err() { printf '错误：%s\n' "$*" >&2; exit 1; }
info() { printf '==> %s\n' "$*"; }

[ "$(uname -s)" = "Darwin" ] || err "Tick 目前仅支持 macOS（检测到 $(uname -s)）。"

TMP="$(mktemp -d)"
MNT=""
cleanup() {
  if [ -n "$MNT" ]; then hdiutil detach -quiet "$MNT" >/dev/null 2>&1 || true; fi
  rm -rf "$TMP"
}
trap cleanup EXIT

# 挂载 dmg，把 .app 拷到 $TMP/x，卸载
extract_dmg() {
  MNT="$TMP/mnt"; mkdir -p "$MNT" "$TMP/x"
  hdiutil attach -nobrowse -readonly -quiet -mountpoint "$MNT" "$1" || err "挂载 dmg 失败。"
  cp -R "$MNT"/Tick.app "$TMP/x/" || err "dmg 中没有找到 Tick.app。"
  hdiutil detach -quiet "$MNT" || true
  MNT=""
  APP_SRC="$TMP/x/Tick.app"
}

APP_SRC=""
ARG="${1:-}"
if [ -n "$ARG" ]; then
  [ -e "$ARG" ] || err "找不到 ${ARG}"
  case "$ARG" in
    *.dmg) info "安装本地 dmg：${ARG}（未校验）"; extract_dmg "$ARG" ;;
    *.app) APP_SRC="$(cd "$(dirname "$ARG")" && pwd)/$(basename "$ARG")"; info "安装本地 app：${APP_SRC}" ;;
    *) err "只接受 .app 或 .dmg：${ARG}" ;;
  esac
else
  case "$(uname -m)" in
    arm64|aarch64) ARCH="arm64" ;;
    x86_64) ARCH="x64" ;;
    *) err "不支持的 CPU 架构：$(uname -m)" ;;
  esac
  # Rosetta 终端里 uname -m 是 x86_64，纠正为真实架构
  if [ "$ARCH" = "x64" ] && [ "$(sysctl -in sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
    ARCH="arm64"
  fi
  command -v curl >/dev/null 2>&1 || err "需要 curl。"
  command -v shasum >/dev/null 2>&1 || err "需要 shasum。"

  VERSION="${TICK_VERSION:-}"
  if [ -z "$VERSION" ]; then
    info "查询最新版本…"
    # 跟随 releases/latest 的跳转，不解析 API JSON（无速率限制）
    FINAL="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "${RELEASES}/latest")" \
      || err "查询失败。请稍后再试，或访问 ${RELEASES}"
    case "$FINAL" in
      */tag/*) VERSION="$(printf '%s' "$FINAL" | sed 's#.*/tag/##')" ;;
      *) err "还没有已发布的版本。请访问 ${RELEASES}" ;;
    esac
  fi
  VERSION="${VERSION#v}"
  TAG="v${VERSION}"
  NAME="Tick-${VERSION}-${ARCH}.dmg"
  BASE="${RELEASES}/download/${TAG}"

  info "下载 ${NAME}（${TAG}）…"
  curl -fL --progress-bar -o "$TMP/$NAME" "${BASE}/${NAME}" || err "下载失败：${BASE}/${NAME}"
  curl -fsSL -o "$TMP/SHA256SUMS.txt" "${BASE}/SHA256SUMS.txt" || err "下载 SHA256SUMS.txt 失败，拒绝安装未校验的包。"

  info "校验 SHA256…"
  EXPECT="$(awk -v n="$NAME" '{f=$2; sub(/^\*/,"",f)} f==n {print $1; exit}' "$TMP/SHA256SUMS.txt")"
  [ -n "$EXPECT" ] || err "SHA256SUMS.txt 中没有 ${NAME} 的记录。"
  ACTUAL="$(shasum -a 256 "$TMP/$NAME" | awk '{print $1}')"
  [ "$EXPECT" = "$ACTUAL" ] || err "SHA256 不匹配（期望 ${EXPECT}，实际 ${ACTUAL}），已中止。"

  extract_dmg "$TMP/$NAME"
fi

if [ -d /Applications ] && [ -w /Applications ]; then
  DEST_DIR="/Applications"
else
  DEST_DIR="$HOME/Applications"; mkdir -p "$DEST_DIR"
fi
DEST="${DEST_DIR}/Tick.app"

# 退出旧实例（优雅退出会 flush durable 会话写入；3 秒兜底强杀）
if pgrep -x Tick >/dev/null 2>&1; then
  info "发现运行中的 Tick，正在退出…"
  osascript -e 'tell application "Tick" to quit' >/dev/null 2>&1 || true
  i=0
  while [ "$i" -lt 30 ] && pgrep -x Tick >/dev/null 2>&1; do sleep 0.1; i=$((i + 1)); done
  pkill -x Tick >/dev/null 2>&1 || true
fi

info "安装到 ${DEST}"
rm -rf "$DEST"
cp -R "$APP_SRC" "$DEST"

# 本地未签名构建需要移除隔离属性；curl 下载的本来就没有（无害）
xattr -dr com.apple.quarantine "$DEST" >/dev/null 2>&1 || true

open "$DEST"

cat <<'MSG'
==> 安装完成。Tick 是菜单栏应用，请在屏幕顶部菜单栏找它的图标。
    快捷键：⌘⌥T 显隐面板 · ⌘⌥N 新建线索
    数据：  ~/.ticktodo（只同步 data/ 即可；凭据只在系统钥匙串）
MSG
