# Tick — 置顶 Todo 工作台（AI 会话的索引层）

> **线索（Todo）是索引，agent 会话是被索引对象。**
> 产品文档：`docs/已对齐/PRD-tick.md`（v0.3） · 架构：`docs/已对齐/TECH-ARCH-tick.md` · 设计规范：`docs/已对齐/UI-SPEC-tick.md`

## 快速开始

```bash
pnpm install        # 首次（hoisted 布局，见 .npmrc）
pnpm dev            # 启动置顶面板（apps/desktop，vite + vite-plugin-electron）
pnpm typecheck      # 全仓 tsc --noEmit
```

> 本机环境注意：WorkBuddy 宿主 shell 会带 `ELECTRON_RUN_AS_NODE=1`，dev script 已内置 unset；直接跑 `vite` 时需先 `unset ELECTRON_RUN_AS_NODE`。

## 运行环境（M0 已验证）

| 项 | 状态 |
|---|---|
| Electron | 44.8.0（内置 **Node 24.22.0 ≥ 22.19**，满足 pi-durable 硬约束，无需 sidecar 预案） |
| pi | 1.3.0（已从 1.2.0 升级；CLI flags 与 RESEARCH-pi 基线一致） |
| 语言/运行时 | 全仓 TypeScript + Node（D13 决定：面板 Chat 进程内跑 pi-durable → 运行时必是 Node） |
| 数据根 | `~/.ticktodo`（`TICK_HOME` 可覆盖），`data/` 0700/0600，含自动生成 README.md |

## 里程碑进度

- [x] **M0** 仓库脚手架 + 置顶悬浮面板（360×520，min 320×420 / max 480×720，右上贴边 16px）+ Todo CRUD（原子写 + 文件锁 + 业务规则 1/4/5 结构）+ pi 升级 1.3.0
- [ ] **M1** ProjectIndex + PiAdapter 实装（argv 投递 / `--session-id` / `--name` / 版本校验 / verify 绕缓存直读）
- [ ] **M2** `create_todo` extension（CLI + 面板共用）+ 面板 Chat（pi-durable@1.3.0，pin 版本）
- [ ] **M3** 多会话绑定 UI + S5 反向建索引 + 快捷键/位置记忆 + 用量统计（单会话维度）+ 自配 provider
- [ ] **M4** electron-builder 打包 + F8 导出（JSON + Markdown）

## 目录

```
tick/
├── apps/desktop/               # Electron 唯一应用
│   └── src/
│       ├── main/               # window · ipc · store(TodoStore) · services/storage（数据根+原子写+锁）
│       ├── preload/            # contextBridge 白名单
│       └── renderer/           # React：panel · capture-line · thread-row（UI-SPEC 第二轮 Calm Panel）
├── packages/
│   ├── shared/                 # Todo / SessionBinding / CliSessionId / IPC 通道（防漂移的单一来源）
│   ├── ai/core/                # adapter 合同 + mergeProjects + canonicalPath + session-ns（M1 实装）
│   ├── ai/pi/                  # PiAdapter（M0: detect→M1 实装 launch/resume/verify）
│   ├── tick-extension/         # pi extension create_todo/list_todos（M2）
│   └── storage/                # 预留
├── docs/已对齐/                # PRD / TECH-ARCH / REVIEW / RESEARCH-*/ UI-SPEC
└── scripts/
```

## 数据层（`~/.ticktodo`）

| 目录 | 性质 |
|---|---|
| `data/` | ✅ 可同步 · 关键（todos.json / cli-sessions.json / settings.json） |
| `sessions/panel-chat/` | ⚠️ 不建议同步 · 含对话正文（M2 pi-durable store） |
| `cache/` | ❌ 可再生（projects.json / window-state.json） |
| `exports/` | F8 手动导出（M4） |

**凭据纪律**：整个数据根不含任何 API Key；自配 provider 的 Key 只进系统钥匙串（safeStorage，M3+）。
