#!/usr/bin/env bash
# 本地发版准备（首次发布；CI 之后再接）。不会签名以外的任何发布动作：
# 只构建 → 生成 SHA256SUMS.txt → 打印 gh release create 命令（不执行）。
#
# 用法：
#   scripts/release-local.sh              # 签名 + 公证（需要你自己设置好环境变量，见下）
#   UNSIGNED=1 scripts/release-local.sh   # 无签名试构建（验证产物形状用，不可发布）
#   ARCHS="arm64" scripts/release-local.sh   # 只出 arm64（默认 "arm64 x64"）
#
# 签名 + 公证（自己在 shell 里 export，别写进文件 / 别发给任何人）：
#   Developer ID 证书从登录钥匙串自动取（mac.identity 已钉为 "Developer ID Application"）
#   公证三选一：
#     export APPLE_ID=...  APPLE_APP_SPECIFIC_PASSWORD=...  APPLE_TEAM_ID=...
#     export APPLE_API_KEY=/path/AuthKey_XXXX.p8 APPLE_API_KEY_ID=... APPLE_API_ISSUER=...
#     export APPLE_KEYCHAIN_PROFILE=tick-notary   # 先用 notarytool store-credentials 存进钥匙串
#     （electron-builder 原生支持 APPLE_KEYCHAIN_PROFILE；私密密码不需要进 shell history）
#
# playbook §8：① 别在 iCloud 同步的 ~/Desktop 里构建（codesign 报 detritus）→ 用
#   git worktree add ~/tick-build <ref> 的副本；本脚本检测到在 Desktop/iCloud 下会拒绝。
#   ② 本地 Developer ID 签名可能卡在 Apple 时间戳服务（0% CPU 静默挂住）：
#   终端设好代理 HTTPS_PROXY 等；久无进展就 Ctrl-C，不要重试（确定性失败）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
OWNER_REPO="Jacky-li-li-li/ticktodo"
ARCHS="${ARCHS:-arm64 x64}"

die() { echo "错误：$*" >&2; exit 1; }

case "$ROOT" in
  "$HOME/Desktop"/*|"$HOME/Documents"/*|*"/Mobile Documents/"*)
    die "$ROOT 在 iCloud 可能同步的目录下，codesign 会挂/报错。请在 ~/tick-build 之类的副本里跑：git worktree add ~/tick-build <分支或 tag>" ;;
esac

# 1) 版本一致性
V_ROOT="$(node -p "require('./package.json').version")"
V_APP="$(node -p "require('./apps/desktop/package.json').version")"
[ "$V_ROOT" = "$V_APP" ] || die "版本不一致：root=$V_ROOT apps/desktop=$V_APP"
VERSION="$V_ROOT"
TAG="v${VERSION}"
echo "==> 版本 ${VERSION}（root 与 apps/desktop 一致）"
if [ -z "${UNSIGNED:-}" ]; then
  git diff --quiet && git diff --cached --quiet || die "工作区有未提交改动"
  git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null || echo "提示：本地还没有 tag ${TAG}（gh release create 会基于默认分支最新提交创建；建议先打 tag 并 push）"
fi

# 2) 构建
pnpm install --frozen-lockfile
pnpm -r typecheck
pnpm --filter @tick/tick-extension build
pnpm --filter @tick/mcp-server build
OUT="apps/desktop/release"
rm -rf "$OUT"
EB_ARGS=()
for a in $ARCHS; do EB_ARGS+=("--$a"); done
if [ -n "${UNSIGNED:-}" ]; then
  echo "==> 无签名试构建（UNSIGNED=1）"
  export CSC_IDENTITY_AUTO_DISCOVERY=false
  EB_ARGS+=("-c.mac.identity=null" "-c.mac.notarize=false")
else
  security find-identity -v -p codesigning | grep -q "Developer ID Application" || die "钥匙串里没有 Developer ID Application 身份"
  if [ -z "${APPLE_KEYCHAIN_PROFILE:-}" ] && [ -z "${APPLE_API_KEY:-}" ] && { [ -z "${APPLE_ID:-}" ] || [ -z "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] || [ -z "${APPLE_TEAM_ID:-}" ]; }; then
    die "公证凭据未设置：请存 notarytool 钥匙串 profile（export APPLE_KEYCHAIN_PROFILE=…），或 export APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID（或 APPLE_API_KEY 三件套）"
  fi
fi
pnpm --filter @tick/desktop build
( cd apps/desktop && npx electron-builder --mac dmg zip "${EB_ARGS[@]}" --publish never )

# 3) SHA256SUMS.txt（安装脚本按 "hash  文件名" 读取）
cd "$OUT"
FILES=()
for f in Tick-"${VERSION}"-*.dmg Tick-"${VERSION}"-*.zip Tick-"${VERSION}"-*.blockmap latest-mac.yml; do
  [ -f "$f" ] && FILES+=("$f")
done
for a in $ARCHS; do
  [ -f "Tick-${VERSION}-${a}.dmg" ] && [ -f "Tick-${VERSION}-${a}.zip" ] || die "缺少 ${a} 的 dmg 或 zip"
done
[ -f latest-mac.yml ] || die "缺少 latest-mac.yml（publish 配置丢了？）"
shasum -a 256 Tick-"${VERSION}"-*.dmg Tick-"${VERSION}"-*.zip > SHA256SUMS.txt
FILES+=(SHA256SUMS.txt)
echo "==> SHA256SUMS.txt"; cat SHA256SUMS.txt
echo "==> 产物"; ls -lh "${FILES[@]}"

# 4) 打印（不执行）发布命令
if [ -n "${UNSIGNED:-}" ]; then
  echo "==> 无签名试构建完成，不可发布。"; exit 0
fi
echo
echo "==> 先验签名/公证（在 ${ROOT}/${OUT} 下）："
echo "    codesign --verify --strict --verbose=2 mac-arm64/Tick.app && xcrun stapler validate mac-arm64/Tick.app"
echo "==> 确认无误后自己执行（本脚本不会执行）："
printf 'gh release create %s \\\n' "$TAG"
for f in "${FILES[@]}"; do printf '  "%s/%s" \\\n' "$PWD" "$f"; done
printf '  --repo %s --title "Tick %s" --notes "Tick %s — macOS (Apple Silicon / Intel)。一行安装见 README / ticktodo.cc。"\n' "$OWNER_REPO" "$VERSION" "$VERSION"
