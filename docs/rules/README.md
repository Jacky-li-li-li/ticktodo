# docs/rules —— 规则文档索引

> 本目录只放**规范性规则**（MUST / MUST NOT），不放调研、历史记录、想法草稿。
> AI 或人先读本文件，再按「何时必读」跳到对应文档；规则与 as-built 代码冲突时**以代码为准，并在同一个 PR 回写规则**。

## 文档清单

| 文档 | 管什么 | 何时必读 | 不适用 / 替代文档 |
| --- | --- | --- | --- |
| [`agent-tool-adapter.md`](./agent-tool-adapter.md) | 给 Tick 接入/修改 AI 工具适配器：`AiToolAdapter` 合同最小集、落地改动面、只读与降级/安全边界、验收清单、文档交付物 | 新增或修改 `packages/ai/*`；在 `main.ts` 注册适配器；改 `ToolIcon` / 工具能力位；写 PRD 的适配器需求章节 | 只想查某工具的存储/深链实测事实 → `docs/workbuddy-adapter-notes.md`；想看产品决策与依据等级 → `docs/prd-session-timeline.md` §9/§9B/§10 |

> 新增规则文档时，必须在本表登记一行；未登记视为不存在。

## 快速路由（先判断你要做什么）

| 你要做的事 | 读哪里 |
| --- | --- |
| 接一个新工具（CLI 或桌面 app） | 本目录 `agent-tool-adapter.md`（全流程 + 验收清单） |
| 查 WorkBuddy 国内版/国际版的实测事实、未验证项 | `docs/workbuddy-adapter-notes.md` |
| 查产品范围、会话时间线规则、WorkBuddy 依据表 A/B | `docs/prd-session-timeline.md` |
| 查架构不变量（锁、verify、TTY、IPC 四处、UI 材质） | `CLAUDE.md`、`docs/已对齐/TECH-ARCH-tick.md` |
| 查 pi 的调研与陷阱 | `docs/已对齐/RESEARCH-pi.md` |

## 维护规则

1. **新规则文件必须在本 README 登记**（文件、管什么、何时必读、不适用），否则视为不存在。
2. **每条规则写可执行判据**：MUST / MUST NOT + 反例或验收项；不写背景故事、不写「建议考虑」。
3. **规则与代码冲突时以 as-built 为准**，同一 PR 内回写规则；不要留「已被 X 取代」的括号注记。
4. **规则不替代证据文档**：实测事实、依据等级、样本数、未验证项放对应工具的 notes / PRD §10，不塞进本目录。
5. 规则文档改动要同步检查：
   - `CLAUDE.md` 的「文档地图 / 当前状态」是否需要改（若新增了入口或改变了适配器现状）；
   - `docs/prd-session-timeline.md` 的合同/依据表是否仍然一致。
