#!/usr/bin/env bash
# Tick 安装通道（TECH-ARCH §1.6：install.sh 只负责装 App，不是业务 CLI）
#
# 用法：
#   scripts/install.sh                 # 自动找 release/ 下的 Tick.app
#   scripts/install.sh path/to/Tick.app
#
# 行为：退出旧实例 → 覆盖 /Applications/Tick.app → open 启动 → 提示快捷键。
set -euo pipefail

cd "$(dirname "$0")/.."

APP="${1:-}"
if [ -z "$APP" ]; then
  # 自动发现：优先 arm64 产物，退而求其次任何 mac* 目录下的 Tick.app
  for cand in \
    "apps/desktop/release/mac-arm64/Tick.app" \
    "apps/desktop/release/mac/Tick.app" \
    apps/desktop/release/mac*/Tick.app; do
    if [ -d "$cand" ]; then APP="$cand"; break; fi
  done
fi

if [ -z "$APP" ] || [ ! -d "$APP" ]; then
  echo "找不到 Tick.app。请先打包：pnpm --filter @tick/desktop dist:dir" >&2
  echo "或显式传入：scripts/install.sh <path-to-Tick.app>" >&2
  exit 1
fi

APP="$(cd "$(dirname "$APP")" && pwd)/$(basename "$APP")"

echo "==> 安装 Tick：$APP → /Applications/Tick.app"

# 退出旧实例（优雅退出会 flush durable 会话写入；3 秒兜底强杀）
if pgrep -x Tick >/dev/null 2>&1; then
  echo "==> 发现运行中的 Tick，正在退出…"
  osascript -e 'tell application "Tick" to quit' >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do
    pgrep -x Tick >/dev/null 2>&1 || break
    sleep 0.1
  done
  pkill -x Tick >/dev/null 2>&1 || true
fi

rm -rf /Applications/Tick.app
cp -R "$APP" /Applications/Tick.app

# 首次安装移出隔离属性（本地构建无签名，否则 Gatekeeper 会拦）
xattr -dr com.apple.quarantine /Applications/Tick.app >/dev/null 2>&1 || true

open /Applications/Tick.app

cat <<'EOF'
==> 安装完成。
    快捷键：⌘⌥T 显隐面板 · ⌘⌥N 新建线索
    数据：  ~/.ticktodo（只同步 data/ 即可；凭据只在系统钥匙串）
EOF
