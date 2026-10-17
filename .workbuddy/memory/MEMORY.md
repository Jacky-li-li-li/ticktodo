# Tick 项目长期记忆

## 定位与语言
- Tick = 置顶 Todo 工作台 = 「AI 会话的索引层」：Todo 是索引，pi session 是被索引对象。飞书能力 v0.3 已移除。
- 语言/运行时（2026-10-17）：**全仓 TypeScript 单语言 + Electron**。决定性理由：面板 Chat 进程内跑 pi-durable（Node 包，Node≥22.19）→ 运行时必是 Node，Tauri/Rust 只会变两套运行时；pi 是 npm/TS 生态，adapter 直接 import 类型。**坑：Electron 内置 Node 须≥22.19（进 M2 验证清单），不够则 ChatAgentHost 移独立 Node 侧进程**。

## 凭据与对外（Q14 修订 / Q15 / F6-c）
- 凭据双来源：来源1=pi 本体（默认，`pi auth check` 探测）；来源2（M3+）=自配 OpenAI 兼容 endpoint（内置 pi-ai）。**Key 只进系统钥匙串（safeStorage），永不进 `~/.ticktodo/data/`**。没 pi 的用户：面板双出口（装 pi 或自配），CLI/索引仍不可用（依赖会话目录）。
- F6-c：对外按**标准协议（MCP 类）**暴露数据与工具（create_todo/list_todos/只读索引/F8 导出即契约），**Tick 不做 LLM 网关**。产品文档不点名 magpie，具名内容都在 RESEARCH-magpie.md。

## pi 1.2.0 实测（升级 1.3.0 后需重核；pi 事实详见 docs/已对齐/RESEARCH-pi.md）
- 可执行 `~/.npm-global/bin/pi`，包 `@earendil-works/pi-coding-agent`。
- 会话 `~/.pi/agent/sessions/<--cwd编码-->/<ts>_<uuid>.jsonl`，首行 header `{type:"session",version,id,timestamp,cwd}`；cwd 权威；目录名编码有损不可反解；顶层散落 jsonl 需容错；31 个 0 字节僵尸 → verify 判 size===0。
- CLI：`pi "消息"` 立即发送；`--session-id` / `--session`(部分uuid) / `--session-dir` / `--name` / `-e`；**无 --cwd**（spawn 工作目录决定）；`--name` 追加 session_info 行（要 name 得全量读，但不缓存正文）；`getDefaultSessionDir()` 会 mkdirSync，cwd 传错造垃圾目录。
- usage 官方口径：**5 源求和**（assistant+toolResult+type:usage+compaction+branch_summary）；cost 仅下限；cacheRead 占 98.9% 可相加；reasoning/cacheWrite1h 不重复加。参考 `scripts/session-usage.mjs`（103/103 自洽，15.25亿 tokens / $39.49 下限）。
- fork：需 session 首行否则抛错；cwd 可换；`parentSession`=源文件路径≠子代理。
- pi-durable@1.3.0（D13，Experimental 必须 pin、Node≥22.19）：harness.resume()、requestId 幂等、`openNodeSqliteStorage/openNodeJsonlStorage`、UsageDoc.fork:"initial"（fork 不继承用量）。

## 既定产品约定（要点）
- 拉起默认剪贴板投递（可审阅），设置可切自动发送；首版两个设置项：投递方式 + 默认项目三态。
- cwd 选填，CwdResolver：①绑定 session 的 cwd ②`Todo.lastLaunch{toolId,projectPath}` ③home 兜底（D18，不猜"最近使用"，其降为设置可选项）；主按钮必须显示项目名。
- 项目主键=canonical 路径（工具只是标签），mergeProjects 纯函数；git 根上卷默认开；**禁止只渲染 basename**（Desktop/pi vs Projects/pi 都高频）；Downloads/tmp 折叠。
- Todo↔session 1:N（primarySessionId=默认 resume）；完成不清绑定、删除保留元数据；一个 session 最多绑一 todo；面板/CLI 会话命名空间隔离。
- 索引只读首行 header，**不读/不缓存对话正文**；adapter 是 session 元数据权威，Tick 只存 `bindings[]`+primarySessionId。
- fork 不去重；跨工具接手有向（pi→外部✅ 反向❌），降级=摘要作首条投递（取 compaction.summary）。
- Q8 取数照 magpie：目录缓存+~2s racy 窗口（verify 必绕缓存直读）、(size,mtime) 文件级增量、Warm/Ask 两级调度（quietReaders=NumCPU/4，事故 #1665）、checkpoint；首帧走 `cache/projects.json`，后台扫完 IPC 推送。不抄：64 路 IO 锁/分片 gob/16384 上限。
- 数据根 `~/.ticktodo`（TICK_HOME 可覆盖）分层：data/(可同步·todos+绑定+settings)、sessions/panel-chat/(不同步)、cache/(可再生)、exports/(F8)。
- F8 导出（M4）：只含索引记录（JSON+MD），必含 filePath+exists，不含正文不复制文件。
- S5 反向建索引进 M3：只手动挑选，不批量自动生成。

## UI（Ardot fileId 737202736253140，6 页）
- **当前主设计 = 第二轮 B（page 3:1606）「Calm Panel 线索式」**：首页=线索列表（勾选圆=归档·标题·最右时间，悬停换「继续」）；展开态 resume-first 给 user 消息树，动作三态：0→新建 / 1→接着做+新建 / N→接着做+查看列表(数字角标)；点空白折叠；菜单含「归档」→ 归档页同构。**捕获行组件母版 `3:1834`**（7 处实例，展开态与首页都必须带）；**线索行最终结构 3:1847**=勾选圆+标题+时间（无副标题），悬停时间换「继续」胶囊。
- 常驻形态（最终方向）：右上常驻 360×300，贴边 16px、避菜单栏、记住相对位置；材质底色 14%+blur56+亮边，跟随系统浅深；**亮度差≤10%** 为不影响观看口径。**穿透开关（第五轮）**：`setIgnoreMouseEvents(true,{forward:true})`，穿透态显式标记+退出键盘可达；悬停加深只表示鼠标在哪；透明度只作用底色层（文字≥70%）。
- **第二轮 C · 补齐状态（7 屏，y=3100/3780）**：R1 首页空态(5:3) · R2 归档反馈-toast可撤销(5:21) · R3 查看列表-会话浮层(5:57) · R4 归档页悬停-「恢复」(5:90) · R5 新建会话-剪贴板反馈(5:117) · R6 工具检测-点新建会话才提示(5:138) · R7 认领历史会话-S5(5:167) · R8 尺寸规范(5:222)。
  规则：**归档=点勾选即生效+顶部横幅「已归档·撤销」(5s)，无确认框**；**归档页悬停→最右变「恢复」**；**查看列表=浮层，点条目=`pi --session` 切回，footer「＋新建会话/认领历史会话」**；**新建会话→文案进剪贴板+toast+「等待第一条消息」**。
  **环境缺失口径（2026-10-17 用户定）**：Tick 不内置模型、**不做安装引导**；只**检测本机有哪些 agent 工具（会话目录）**，
  且**只在触发它的动作上提示**（点「新建会话」才提示"没有可用的 agent 工具"+已扫描结果+重新检测），**不挂常驻横幅**。
  → 第一轮的「11 · pi 未就绪」**已删除**（3:205，第一轮标题改 10 屏）。
  **toast 规范（2026-10-17 用户定稿）**：**浮在顶部捕获行之上**——`x=14, y=43, w=332, h=46, radius=16`，正好覆盖那条输入行，
  相当于"输入行临时变成一条状态行"；**3 秒自动消失**，**不占任何布局空间**；深底 + 语义色 16% 底与 34% 描边 / 左 13px 图标 / 右侧可选「撤销」。
  既不要流内插入（会顶内容），也不要放面板底部（用户明确要盖在 + 上）。
  **R9 新建会话页(5:261) = 独立整页**（不是 sheet）：`← 新建会话` → 线索名 → **可改的文案编辑框** → **工具胶囊由用户自己选**
  （pi / claude code / codex，不做"默认最近使用"的猜测）→ 项目行 → 底部主按钮「复制文案并打开 pi」→「不自动发送」。
  **整页不带首页那条 + 捕获行**（已进入开会话流程，语义冲突）。
- **尺寸定案（2026-10-17）**：面板**固定 360×520，用户可以拖拽右下角改尺寸**（最小 320×420 / 最大 480×720）；
  **内容超出时只有列表区滚动（顶栏与捕获行固定）**；**拉伸后记住尺寸、不随线索多少自动变高**。
  → 所以"底部空 139px"**不是缺陷，不用加行也不用收窄**（规范图 = `R8 尺寸规范` 5:222）。
- **归档已完成 = 绿底 + 白勾**：`Checked Box`(17×17 frame, radius 9, 绿底, 居中 9×9 白勾 svg)，已覆盖 A1 归档页 / R4 / S1 草图。
  第一轮 02 已完成（对照稿）仍是纯绿圆，未补。
- 待拍板：无（前两项已定）。

## 文档
`docs/已对齐/`：PRD / TECH-ARCH（v0.3+）/ REVIEW（决策评审）/ RESEARCH-pi（**pi 事实以此为准**）/ RESEARCH-magpie（§7=取数冷启动方案）/ **UI-SPEC-tick（设计规范，2026-10-17 从第二轮画布抽取：色板/字体/圆角/间距/尺寸 + 6 条玻璃材质配方 + 8 个组件 + 交互规则 + 18 屏清单）**。旧 UI 稿 `docs/ui/board.html`；发版打包链路未落地（无 electron-builder）。
