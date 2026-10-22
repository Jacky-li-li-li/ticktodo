# Ticktodo — 项目规则（Agent 入口）

> 深度资料：`CLAUDE.md`（架构、不变量、适配器细节）、`README.md` / `README.zh-CN.md`（产品说明）、
> `docs/已对齐/`（PRD 与架构）。本文件只记「怎么在这个仓库里干活」，冲突时以 as-built 代码为准。

## 一句话

macOS 菜单栏常驻的置顶面板：以 Todo（线索）为索引，把同一个 todo 在不同 AI 工具里的会话聚在一起，
点一下回到任意会话继续。全仓 TypeScript + Electron 44（内置 Node ≥ 22.19）。

## 常用命令

```bash
pnpm install                 # .npmrc 固定 node-linker=hoisted，勿改
pnpm dev                     # 先 build tick-extension，再起 Electron（vite 5173）
pnpm typecheck               # 全仓 tsc --noEmit（提交前必跑）
pnpm selftest:prefill        # 预填 / 多工具边界（不启动 Electron）
pnpm selftest:update         # 应用内更新状态机
pnpm mcp:check               # MCP server 回归（真实 stdio 客户端）
pnpm --filter @tick/desktop dist:dir   # 本地出 .app（apps/desktop/release）
bash scripts/release-local.sh          # 正式发版（签名 + 公证 + SHA256SUMS）
```

- 宿主 shell 可能带 `ELECTRON_RUN_AS_NODE=1`：`pnpm dev` 已 unset；直接跑 vite 也要先 unset。
- 不要在 iCloud 同步目录里做签名构建（codesign 报 detritus）；用 `git worktree add ~/tick-build <ref>`。

## 目录地图

| 路径 | 作用 |
|---|---|
| `apps/desktop/src/main` | 主进程：服务（launch / sessions / project-index / chat-host / update / mcp-connection）、IPC、窗口 |
| `apps/desktop/src/renderer` | React 面板：`app/` hooks、`features/`（list / todo-detail / ai-picker / sessions / panel-chat / settings）、`styles.css` 布局与业务 class |
| `packages/ai/*` | 15 个适配器（`pi`、`workbuddy`、`workbuddy-ai`、`claude`、`claude-desktop`、`qoder`、`qoder-cn`、`codex`、`cline`、`grok`、`omp`、`kimi`、`opencode`、`zcode`、`dsh`） |
| `packages/ai/core` | 适配器合同与纯函数（不得依赖具体适配器 / Electron） |
| `packages/shared` | 领域类型 + IPC 通道常量 + `TOOL_DISPLAY_NAMES` |
| `packages/todo-core` | `todos.json` 唯一写实现（锁 / 原子写 / 幂等） |
| `packages/ui` | 玻璃材质与设计令牌的唯一来源 |
| `packages/mcp-server` | stdio MCP server（打包进 app 的 `Resources/mcp/`） |
| `site/` | 官网 `ticktodo.cc`（GitHub Pages，静态单页） |
| `scripts/` | 安装 / 发版 / 只读探针 / selftest 入口 |

## 硬约束（容易踩的）

1. 锁只有一份：`packages/todo-core`。不要在 Main、扩展或 MCP server 里另写一套。
2. 会话元数据以工具侧为准：不建镜像表，不缓存正文。
3. UI 材质只来自 `@tick/ui`；不用蓝色，主按钮金属黑、次按钮石墨，语义色只有绿 / 红。
4. 窗口保持 `frame: true + titleBarStyle: 'hidden'`（vibrancy 圆角 mask 的前提）。
5. Cmd+Q 才真正退出；关窗只是隐藏，退出前要 await `chat.close()`。
6. `scripts/install.sh` 与 `site/install.sh` 必须逐字节一致。
7. 发版时根 `package.json` 与 `apps/desktop/package.json` 版本必须一致，tag 为 `v<version>`。
8. 安装版与 dev 实例共用 `~/Library/Application Support/Tick` 的单实例锁：装包/验收前先退出 dev 实例
   （`osascript -e 'tell application id "com.github.Electron" to quit'`）。**不要用删 SingletonLock 的方式强行并行**——
   两个实例共用同一份 userData 会争 `todos.json` 与面板会话存储。

## 官网（`site/`）

静态单页，无构建步骤，推 `site/**` 到 main 即触发 GitHub Pages。

| 文件 | 内容 |
|---|---|
| `index.html` | 页面结构 + 中英双语（英文写在元素的 `data-en` 上）+ 图标 sprite + `window.TICK_SITE` 版本配置 |
| `assets/site.css` | 排版与各区块（令牌、导航、首屏、功能卡、工具墙、进展、原理、上手、页脚、响应式） |
| `assets/panel.css` | App 面板还原样式（`.tk-*`、迷你桌面、终端 / 桌面窗口、演示光标） |
| `assets/site.js` | 无依赖脚本：语言、发布状态、下载链接、复制、工具墙、FLIP 对比图、迷你交互、首屏演示 |
| `assets/tools/*.png` | 官方工具图标位图（来源见 `apps/desktop/src/renderer/features/icons/assets/README.md`） |

维护要点：

- **发版只改 `index.html` 底部的 `window.TICK_SITE`**：`version` / `date` 决定下载链接与页脚版本；
  填上 `nextShippedIn` 后，页面上所有「下一版」徽标变成「已发布 vX」，「即将发布」整栏切到已发布，
  下载链接也切到新版本（可选 `nextDate`）。
- 工具能力与状态在 `site.js` 的 `TOOLS` 数组里维护（`resume` / `create` / `since`），工具墙与跑马灯共用它。
- 演示面板（`.tk-*`）是 App 的**还原示意**，数值跟 `apps/desktop/src/renderer/styles.css` 对齐；
  改 App 面板的尺寸、按钮或滑块语义时，同步改这里，别让官网和真机两张皮。
- 文案：中文写在 DOM 里，英文写在 `data-en`（属性值里的引号用 `&quot;`）；动态内容用 `L(zh, en)`。
- 主题跟随系统，`?theme=dark|light` 可强制；语言可用 `?lang=en` 强制，切换后记在 localStorage。
- 动效都要尊重 `prefers-reduced-motion`：停循环、停位移，内容与交互仍可用。

本地验证（无需构建）：

```bash
# 用本机 Chrome 无头模式按指定宽度截图，顺便抓控制台错误
node <会话工作台>/qa/shot.mjs "file://$PWD/site/index.html" site-1280 --w=1280 --h=900 --full
```

检查项：1280 / 768 / 390 三个宽度无横向溢出（`scrollWidth === innerWidth`）、控制台无异常、
深色与英文各看一遍、演示四步能依次走到（写线索 → 打开线索 → 接着做 → 新建会话）。

## 验证与提交

- 改代码：`pnpm typecheck` + 相关 selftest（`selftest:prefill` / `selftest:update` / `mcp:check`）。
- 改官网：上面的无头截图 + 手动点一遍首屏演示、工具筛选、MCP 切换、语言切换、复制按钮。
- 提交信息用中文 `feat(scope): …` / `fix(scope): …`；只提交本次相关的文件。
