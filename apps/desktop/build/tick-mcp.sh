#!/bin/sh
# Tick MCP server 启动器（app 内置形态）。
#
# 客户端 MCP 配置里的 command 指向本文件；它把 Electron 二进制切换成 Node 模式，
# 再跑 Resources/mcp/tick-mcp.mjs。这样用户不需要装 Node/npm，且 server 版本随 app 更新。
#
# 路径自解析：app 被拖到 ~/Applications 或改名目录也能用（但客户端配置里的路径仍需真实路径）。
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
CONTENTS="$(cd "$HERE/../.." && pwd)"
export ELECTRON_RUN_AS_NODE=1
exec "$CONTENTS/MacOS/Tick" "$HERE/tick-mcp.mjs"
