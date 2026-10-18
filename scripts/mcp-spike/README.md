# MCP spike — 把 Tick 的 `todos.json` 暴露成 MCP stdio server

状态：**技术验证（spike）**。只新增 `scripts/mcp-spike/`，不改产品代码、不装依赖、不联网；
所有临时数据都落在 `/tmp/tick-spike`（`TICK_HOME` 指向它），**不碰 `~/.ticktodo`**。

一句话结论：**协议链路完全可行，但 stdio MCP 拿不到「AI 会话 id」**——客户端只能告诉我们
「我是 pi / claude-code」，不能告诉我们「我是哪一个会话」。这决定了产品化时的绑定策略（见 §8）。

---

## 1. 文件

| 文件 | 作用 |
|---|---|
| `server.mjs` | 零依赖 MCP stdio server（换行分隔 JSON-RPC 2.0，自实现，不用 SDK） |
| `check-client.mjs` | 用 **真实客户端库** `@earendil-works/pi-mcp` 的 `McpClient` + `StdioTransport` 跑 19 条断言 |
| `concurrency.mjs` | (a) 6 进程 × 20 并发写；(b) 真实 Main 侧 `TodoStore` 与 3 个 server 进程跨运行时并发写 |

## 1b. 取证文件

`evidence/capture-pi.json` / `evidence/capture-claude.json` 是 `pi mcp list` / `claude mcp list`
真实接入时 server 抓到的 `initialize` 参数（clientInfo / capabilities / 协议版本）。
关键结论：**两个客户端都不提供 session id，也不提供 cwd**——这是 PRD 里「句柄回扫」方案的直接依据。

## 2. 怎么跑

```bash
cd <repo>  # 仓库根
node scripts/mcp-spike/check-client.mjs     # 19 条断言，全 PASS 时 exit 0
node scripts/mcp-spike/concurrency.mjs      # 5 条断言，全 PASS 时 exit 0
```

- 不需要 `pnpm install`，只用仓库根 `node_modules` 里已有的 `@earendil-works/pi-mcp` 和
  `node_modules/.bin/esbuild`。
- 临时根目录默认 `/tmp/tick-spike`，可用 `TICK_SPIKE_TMP` 覆盖。
- `concurrency.mjs` 会执行任务书指定的打包命令并把产物留在 `/tmp/tick-spike/store.mjs`：
  `esbuild apps/desktop/src/main/store.ts --bundle --platform=node --format=esm`
  （实测一次通过，`store.ts` 对 `@tick/shared` 只有 `import type`，esbuild 直接擦除，
  不需要 `--external:@tick/shared`，也没走降级实现）。

## 3. `server.mjs` 行为

### 3.1 协议

| 方法 | 行为 |
|---|---|
| `initialize` | 版本协商：客户端版本 ∈ `2025-11-25 / 2025-06-18 / 2025-03-26 / 2024-11-05` 则回显，否则回 `2025-11-25`；`capabilities.tools = {listChanged:false}`；`serverInfo = tick-spike@0.0.1`；一句 `instructions` |
| `notifications/initialized` | 只记录日志（通知无 id、不回包） |
| `ping` | 回 `{}` |
| `tools/list` | 3 个工具，JSON Schema + annotations |
| `tools/call` | 未知工具 → `isError:true` 的 CallToolResult（不是 -32601） |
| 未知方法 | `-32601 Method not found` |
| `initialize` 之前的其它请求 | `-32002 Server not initialized`，**不崩**，之后仍可正常 initialize |
| 非法 JSON 行 | `-32700`，连接继续 |

`stdout` 每行恰好一条 JSON-RPC；日志只走 `TICK_MCP_LOG`（缺省 stderr）；stdin 关闭 → 处理完缓冲后 exit 0。

### 3.2 工具

| 工具 | 入参 | annotations |
|---|---|---|
| `create_todo` | `title`（必填）、`body?`、`session_id?`、`tool_id?`、`cwd?`、`request_id?` | `readOnlyHint:false, destructiveHint:false, idempotentHint:true, openWorldHint:false` |
| `list_todos` | `status?`（open/done/all，默认 open）、`limit?`（默认 50，上限 500） | `readOnlyHint:true, destructiveHint:false, idempotentHint:true, openWorldHint:false` |
| `link_session` | `todo_id`、`session_id`（必填）、`tool_id?`、`cwd?` | 同 `create_todo` |

- `create_todo` 返回 `content[0].text` 摘要 + `structuredContent {todoId,title,created,bound}`。
- `list_todos` 返回文本摘要 + `structuredContent {count,todos[]}`（精简字段：id/title/status/createdAt/updatedAt/primarySessionId/bindings）。
- `link_session` 返回 `structuredContent {ok,todoId,bound:{toolId,sessionId,boundAt,state}}`；
  同 session 已绑别的 todo 时 `isError:true`，文案明确写「会话 xxx 已绑定到「标题」」。
- `tool_id` 解析顺序：入参 → `TICK_AGENT_TOOL` → `initialize.clientInfo.name` → `"mcp"`。
- `session_id` 回落 `TICK_AGENT_SESSION`。

### 3.3 环境变量

| 变量 | 含义 |
|---|---|
| `TICK_HOME` | 数据根，默认 `~/.ticktodo`；spike 里始终指向 `/tmp/...` |
| `TICK_AGENT_TOOL` | 工具 id 回落值（`pi` / `claude-code` / …） |
| `TICK_AGENT_SESSION` | `session_id` 回落值（**只能由启动 server 的进程注入**） |
| `TICK_MCP_READONLY=1` | 写工具（create/link）返回 `isError`，`list_todos` 仍可读 |
| `TICK_MCP_LOG` | 日志文件；缺省 stderr；两者都不写 stdout |
| `TICK_MCP_CAPTURE` | 把 `initialize` 的 params 落成 JSON（联调取证用） |

### 3.4 写盘协议（逐字复用 `packages/tick-extension/src/todos-file.ts`）

- 锁文件 `<todos.json>.lock`（**名字不能变**，Main 的 `services/storage.ts` 用同一个）；
  `O_EXCL` 创建，内容 `<pid>:<uuid>` token，释放只删自己 token 的锁，mtime 超 5s 视为陈旧锁强夺。
- `tmp + fsync + rename` 原子写，文件与目录 `0600/0700`；解析失败先备份 `<file>.corrupt-<ts>`。
- `requestId` 幂等、同 `sessionId` 幂等（命中**不写文件**，避免触发 Main 的 `fs.watch`）。
- 唯一实现差异：`source` 只能写 `'panel' | 'pi'`（联合类型没有 mcp），spike 记 `'pi'`；`cwd` 没有字段可落，只记日志。

## 4. 断言清单：`check-client.mjs`（19 条）

| # | 断言 | 这条在证明什么 |
|---|---|---|
| 1 | initialize 成功，`serverInfo.name=tick-spike`、`version=0.0.1`、instructions 非空 | 真实 `McpClient` 的 `validateInitializeResult` 接受我们的应答 |
| 2 | 客户端请求 `2025-11-25` → 原样回显 | 版本协商不是硬编码 |
| 3 | `capabilities.tools.listChanged === false` | 能力声明符合任务要求 |
| 4 | `tools/list` 3 个工具，名字/annotations/`inputSchema.required` 全对 | 工具契约可被客户端解析 |
| 5 | `create_todo` 建成，`todos.json` 恰好 1 条，binding 的 toolId/sessionId/state、`primarySessionId`、`requestId` 全对 | 领域数据形状与产品一致 |
| 6 | 同 `session_id` 再 create → `created=false`，总数仍 1 | 同会话幂等（且不重复写盘） |
| 7 | 重复 `request_id`（换标题）→ `created=false`、返回同一 todoId、总数不变 | requestId 幂等优先于标题 |
| 8 | `list_todos(status=all)` 读到上面两条，text 摘要非空 | 读路径 + 双返回（text + structured） |
| 9 | `list_todos(status=open, limit=1)` 只回 1 条 | status/limit 过滤 |
| 10 | 另建 B/C 两条（不绑会话） | 为绑定冲突准备数据 |
| 11 | `link_session` 把 `sess-B` 绑到 B 成功；再调一次不新增 binding | 绑定成功 + 绑定幂等 |
| 12 | 同 `sess-B` 绑 C → `isError`，文案含「已绑定到「spike-B：待绑定」」，C 未被写入 | 一个 session 最多一条 todo |
| 13 | `TICK_MCP_READONLY=1` 独立实例：create/link 都 `isError`、不产生 `todos.json`，list 仍可读 | 只读开关真的挡住写 |
| 14 | `TICK_AGENT_SESSION` / `TICK_AGENT_TOOL` 在缺省参数时生效 | 环境变量回落链路 |
| 15 | `TICK_MCP_CAPTURE` 落文件，`clientInfo.name` 记录正确 | 联调取证机制可用 |
| 16 | `TICK_MCP_LOG` 有日志，stderr 不含日志、不含 JSON-RPC | 日志路由不污染传输 |
| 17 | 裸进程 6 条应答全是合法 JSON-RPC 2.0；未知方法 `-32601`；未知工具 `isError`；stdin 关闭 exit 0；stderr 有日志但无 `"jsonrpc"` | stdio 传输卫生（stdout 无日志、stderr 无协议） |
| 18 | 请求 `2099-12-31` → 回 `2025-11-25`；请求 `2024-11-05` → 回显 | 版本降级策略 |
| 19 | initialize 前发 `tools/list` → `-32002`，随后 initialize 仍成功、server 未崩 | 未初始化请求的错误处理 |

（第 17 条同时覆盖任务书里的「stderr 不含 JSON-RPC 应答、stdout 无日志污染」。）

## 5. 断言清单：`concurrency.mjs`（5 条）

| # | 断言 | 这条在证明什么 |
|---|---|---|
| 1 | (a) 6 个 server 子进程并发各写 20 条 → **恰好 120 条**、id 唯一、每个 pid 各 20 条、无 `.tmp` 残留、无 `.corrupt-*`、锁文件最终不存在 | 同款协议在多进程下不丢写 |
| 2 | (b) esbuild 打包真实 `TodoStore` 成功（导出 `TodoStore`） | 不是复制品，是 Main 侧产品代码 |
| 3 | (b1) `TodoStore.create()` 与 3 个 server 进程**同时**各写 20 条 → **80 条守恒**，`store.list()` 也读到 80 | 跨运行时锁协议真的互通 |
| 4 | (b2) 再补 2 个 server 进程 ×20 → **总数 120 条** | 对齐任务书写的 120 条（1 store + 5 server 进程累计） |
| 5 | (b3) `TodoStore` 读到 server 写的条目、server 的 `list_todos` 也读到 `TodoStore` 写的条目 | 双向可见，不是「各写各的」 |

> 关于 120：任务书 (b) 写「TodoStore 与 3 个 server 各写 20 → 120」，但 1×20 + 3×20 = **80**。
> 脚本把 80 作为 (b1) 的精确断言，再追加 2 个 server 进程 ×20（(b2)）把总数凑到任务书要求的
> **120** 并再断言一次；两次都零丢写、锁文件最终不存在。

## 6. 实测输出（本机 macOS / Node v22.22.3）

```
$ node scripts/mcp-spike/check-client.mjs
PASS  initialize：serverInfo.name=tick-spike / version=0.0.1 / instructions 非空
PASS  协议版本协商：客户端请求 2025-11-25 → 原样回显
PASS  capabilities.tools.listChanged === false
PASS  tools/list：3 个工具，名字/annotations/inputSchema 均符合预期
PASS  create_todo：建成 1 条，todos.json 落盘，binding.toolId/sessionId 正确
PASS  幂等（session_id）：同会话再 create → created=false，总数仍为 1
PASS  幂等（request_id）：重复 request_id → created=false，总数不变
PASS  list_todos：能读到上面两条（status=all）
PASS  list_todos：status/limit 过滤生效（open + limit=1）
PASS  准备第二/第三条 todo（不绑定会话）
PASS  link_session：把 sess-B 绑到第二条 todo 成功
PASS  link_session：同 session 绑第三条 → isError 且指出已绑定到「spike-B」
PASS  TICK_MCP_READONLY=1：独立实例 create_todo 返回 isError，list 仍可读
PASS  环境变量回落：TICK_AGENT_SESSION / TICK_AGENT_TOOL 在缺省参数时生效
PASS  capture：initialize params 落文件，clientInfo.name 已记录
PASS  日志路由：TICK_MCP_LOG 文件有日志，stderr 不含日志/JSON-RPC
PASS  stdout 卫生：每行都是合法 JSON-RPC，未知方法 -32601，未知工具 isError
PASS  协议协商降级：请求 2099-12-31 → 回 2025-11-25；请求 2024-11-05 → 原样回显
PASS  initialize 之前的请求返回 -32002 且不崩，之后仍可 initialize

19/19 PASS
全部通过。
```

```
$ node scripts/mcp-spike/concurrency.mjs
PASS  (a) 6 个 server 进程并发各写 20 条 → 120 条且无丢写  — 120 todos · 6 writers × 20 · lock=absent
PASS  (b) esbuild 打包 Main 侧 TodoStore（apps/desktop/src/main/store.ts）  — /tmp/tick-spike/store.mjs (7728B, export=[TodoStore])
PASS  (b1) TodoStore + 3 个 server 同时各写 20 条 → 80 条守恒（真实 Main 代码）  — 80 todos · 1 store + 3 servers（store.list 也读到 80）
PASS  (b2) 再补 2 个 server 进程 × 20 → 总数对齐任务书的 120 条  — 120 todos · 累计 1 store + 5 server 进程 · 无丢写
PASS  (b3) 跨运行时读：TodoStore 能读到 server 写的条目，字段完整  — 双向可见（Main→文件←server）

5/5 PASS
全部通过。
```

结论：**并发写不丢**（240 次 server 写 + 80 次跨运行时写全部守恒），**锁互通**
（同一个 `<todos.json>.lock`），**锁文件最终清理干净**（无 `.tmp`、无 `.corrupt-*`、无 `.lock`）。

## 7. 真机联调（隔离配置，未污染用户环境）

### 7.1 pi 1.3.0

```bash
PI_CODING_AGENT_DIR=/tmp/tick-spike-pi pi mcp add tick-spike \
  --env TICK_HOME=/tmp/tick-spike/pi-data \
  --env TICK_AGENT_TOOL=pi \
  --env TICK_MCP_CAPTURE=/tmp/tick-spike/capture-pi.json \
  --env TICK_MCP_LOG=/tmp/tick-spike/pi-server.log \
  -- node /path/to/repo/scripts/mcp-spike/server.mjs
# Added global MCP server "tick-spike" in /tmp/tick-spike-pi/mcp.json.

PI_CODING_AGENT_DIR=/tmp/tick-spike-pi pi mcp list   # spawnSync, timeout 20s
# tick-spike: connected, 3 tools (codemode, global)
#   node .../scripts/mcp-spike/server.mjs
#   tools: create_todo, list_todos, link_session
# exit 0，无报错
```

生成的 `/tmp/tick-spike-pi/mcp.json`（真实 `~/.pi/agent/mcp.json` 仍然不存在）：

```json
{
  "mcpServers": {
    "tick-spike": {
      "command": "node",
      "args": ["/path/to/repo/scripts/mcp-spike/server.mjs"],
      "env": {
        "TICK_HOME": "/tmp/tick-spike/pi-data",
        "TICK_AGENT_TOOL": "pi",
        "TICK_MCP_CAPTURE": "/tmp/tick-spike/capture-pi.json",
        "TICK_MCP_LOG": "/tmp/tick-spike/pi-server.log"
      }
    }
  }
}
```

capture 到的 `initialize` params（`/tmp/tick-spike/capture-pi.json`）：

```json
{
  "protocolVersion": "2025-11-25",
  "capabilities": { "roots": {} },
  "clientInfo": { "name": "pi", "version": "1.3.0" }
}
```

服务端日志证明 pi 真的调了 `tools/list`：`tools/list → 3 个工具`。
注意 pi 默认以 **codemode** 暴露 MCP 工具（`3 tools (codemode, global)`）；若要像原生工具一样
直接 function-call，需要 `--exposure direct`（本次未验证）。

### 7.2 Claude Code 2.1.302

```bash
CLAUDE_CONFIG_DIR=/tmp/tick-spike-claude claude mcp add --scope user tick-spike \
  -e TICK_HOME=/tmp/tick-spike/claude-data \
  -e TICK_AGENT_TOOL=claude-code \
  -e TICK_MCP_CAPTURE=/tmp/tick-spike/capture-claude.json \
  -e TICK_MCP_LOG=/tmp/tick-spike/claude-server.log \
  -- node /path/to/repo/scripts/mcp-spike/server.mjs
# Added stdio MCP server tick-spike ... to user config
# File modified: /tmp/tick-spike-claude/.claude.json

CLAUDE_CONFIG_DIR=/tmp/tick-spike-claude claude mcp list   # spawnSync, timeout 30s
# Checking MCP server health…
# tick-spike: node .../scripts/mcp-spike/server.mjs - ✔ Connected
# exit 0
```

**`CLAUDE_CONFIG_DIR` 生效**：配置写到 `/tmp/tick-spike-claude/.claude.json`；
用户真实的 `~/.claude.json` 在 add/list 前后 SHA-256 完全一致
（`a5548983953e6714cf74d6effe8426bfe9bbed838b0bc1acbbb27f4fba5d87c8`），mtime 也未变。
`claude mcp list` 的健康检查确实连上了 server 并调用了 `tools/list`（服务端日志有
`tools/list → 3 个工具`），但 CLI 输出只显示 `✔ Connected`，不显示工具数量。

capture 到的 `initialize` params（`/tmp/tick-spike/capture-claude.json`）：

```json
{
  "protocolVersion": "2025-11-25",
  "capabilities": {
    "roots": { "listChanged": true },
    "elicitation": { "form": {}, "url": {} }
  },
  "clientInfo": {
    "name": "claude-code",
    "title": "Claude Code",
    "version": "2.1.302",
    "description": "Anthropic's agentic coding tool",
    "websiteUrl": "https://claude.com/claude-code"
  }
}
```

### 7.3 两个客户端的 initialize 对照

| 字段 | pi 1.3.0 | Claude Code 2.1.302 |
|---|---|---|
| `protocolVersion` | `2025-11-25` | `2025-11-25` |
| `clientInfo.name` | `pi` | `claude-code` |
| `clientInfo.version` | `1.3.0` | `2.1.302` |
| `capabilities` | `{roots:{}}` | `{roots:{listChanged:true}, elicitation:{form,url}}` |
| 会话 id | **没有** | **没有** |
| cwd | **没有**（只声明 roots 能力） | **没有**（只声明 roots 能力） |

## 8. 设计约束 / 坑（实测得出）

1. **stdio MCP 无法知道「客户端会话 id」**。`initialize` 只有 `clientInfo`（产品级身份）+ 协议版本；
   stdin/stdout 没有 session 头（那是 Streamable HTTP 的 `Mcp-Session-Id`，且它标识的是 MCP 连接，
   不是 AI 会话）。`TICK_AGENT_SESSION` 能注入，但 `mcp.json` 的 env 是**注册时静态写死**的，
   client 不会按会话重新拉起服务器——所以 env 方案只能表达「这个配置属于某个固定会话」，
   表达不了「用户此刻在哪个会话」。
2. **clientInfo 只能区分工具，不能区分会话实例**：pi 报 `pi`，Claude 报 `claude-code`，
   同一工具开 3 个会话时三次 initialize 完全一样（除非 client 主动传参）。
3. **唯一可行的会话识别通道是「让模型自己传」**：`session_id` 作为工具入参（agent 侧才知道自己的会话 id），
   或者 Tick 先生成一个绑定 token（剪贴板/环境变量）再由模型带回来。二者都需要 prompt/工具描述配合。
4. **`roots` 能力是 cwd 的候选来源**：两个客户端都声明了 `roots`，server 可以反向发
   `roots/list` 拿工作区根目录（本次未实现/未验证）；这能提供「目录」维度，仍不是会话 id。
5. **Claude Code 的健康检查不会调 `tools/call`**，只 initialize + `tools/list`；所以「Connected」
   不等于工具真的能跑，`tools/call` 必须自己测（本 spike 用 `check-client.mjs` 覆盖）。
6. **pi 默认 `--exposure codemode`**：工具被包进 codemode 执行面，而不是直接 function call；
   接 Tick 时要想清楚走哪种暴露方式。
7. **stdout 是硬约束**：任何 `console.log`/依赖的 banner 都会破坏传输；本 server 用单次
   `write(JSON.stringify(msg)+"\n")`，日志只走 stderr/文件。
8. **锁文件名是跨运行时契约**：Main `services/storage.ts` 与 extension `todos-file.ts` 都用
   `<todos.json>.lock`；spike 原样复用后，真实 `TodoStore` 与 5 个 server 进程混写 120 条零丢写。
9. **5s 陈旧锁是双刃剑**：写入若被拖过 5s（大文件/慢盘/进程被 SIGSTOP），锁会被别人强夺并可能丢写；
   当前写入是毫秒级所以安全，产品化要留意大 `todos.json` 与 fsync 抖动。
10. **同步 API 不能 await**：`todos-file.ts` 的锁等待用 `Atomics.wait` 自旋；在 MCP server 里同样
    只能同步等，超过 5s 就抛错（绝不「无锁继续写」）。
11. **读操作也可能有副作用**：损坏备份只在写路径触发，`list_todos` 只读不备份（与产品一致）。
12. **只读开关是全局 env**，不是 per-tool 授权；MCP 的 `destructiveHint` 只是给客户端的提示，
    真正拦截靠 `TICK_MCP_READONLY`。

## 9. 与产品实现的差距（一句话一条）

- server 是**第二份协议实现**（复制语义而非 import）：产品化应把 `todos-file.ts` 抽成可打包共享的包，否则三份实现迟早漂移。
- `Todo.source` 只有 `'panel' | 'pi'`，MCP 来源只能记成 `'pi'`：需要扩共享类型（如 `'mcp'`）才能区分来源。
- `cwd` 在 `Todo` / `SessionBinding` 里没有字段：spike 只写日志，产品要么扩类型要么明确丢弃。
- spike 没有 `fs.watch` / `todos:changed`：写盘后 UI 不会实时刷新（Main 在跑时会自己感知文件变化）。
- 没有 resources / prompts / 变更通知（`listChanged:false`）：只做 tools，客户端无法订阅 Todo 变化。
- 没有 per-tool 权限、用户确认、审计：`TICK_MCP_READONLY` 是全局粗粒度开关。
- `tools/call` 错误只有 `isError` + 文案，没有机器可读错误码/`structuredContent` 错误体。
- 手写 JSON Schema，未从 TS 类型生成，存在类型与 schema 漂移风险。
- 未实现分页（`nextCursor`）、取消（`notifications/cancelled`）、进度（progress）。
- 无鉴权与来源校验：任何能注册 MCP server 的客户端都能读写 `todos.json`（与现有 extension 同等信任级别）。
- 认证/会话识别只能靠外部注入（env/入参），产品需要明确的「会话绑定 token」设计。
- 没有进入 `pnpm typecheck`：spike 脚本是 `.mjs`，不参与全仓类型检查。
- 未验证在 pi 的 codemode 模式下工具是否可被模型直接调用（只验证了 tools/list 与真实 `tools/call` 客户端调用）。

## 10. 清理

- 测试数据：`concurrency.mjs` / `check-client.mjs` 的 `TICK_HOME` 都在 `/tmp/tick-spike/...`，
  跑完可直接 `rm -rf /tmp/tick-spike/check-* /tmp/tick-spike/conc-*`。
- 用户真实数据：`~/.ticktodo` **完全未触碰**（所有实例都显式设置了 `TICK_HOME`）。
- 客户端隔离：pi 用 `PI_CODING_AGENT_DIR`，Claude 用 `CLAUDE_CONFIG_DIR`；联调后
  `~/.pi/agent/mcp.json` 仍不存在、`~/.claude.json` 哈希不变。
