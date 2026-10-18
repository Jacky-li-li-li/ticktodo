# WorkBuddy 适配调研与实测笔记（CN 5.8.3 / intl 5.8.4，2026-10-18；复核 2026-10-19）

> 本文分三层：**§0 最终结论** → 事实与深链（§1–§9）→ **§10 国际版逐轮实测（历史记录，最终结论见 §0/§10.11）**。
> 数据侧全程只读：DB 复制到临时目录后以 `mode=ro` 读取，不读密钥/正文；深链侧执行了 `open` 与应用退出/重启（未改配置、未发消息）。文中 session id/标题/路径均为占位符，仓库内不含截图。

## 0. 最终结论摘要（先看这里）

> §10.1–§10.10 是逐轮实测记录（历史）；**当前结论以本节与 §10.11 为准**。PRD 仍按 §10.8/§10.9/§10.10 引用具体轮次的判据与样本。

### 0.1 两个工具（不得互相套用）

| 项 | 国内版 WorkBuddy | 国际版 WorkBuddy AI |
|---|---|---|
| App / bundle | `/Applications/WorkBuddy.app`，`com.tencent.workbuddy.mac` | `/Applications/WorkBuddy AI.app`，`com.workbuddy.workbuddy-ai` |
| 版本 | 5.8.3（已验证） | 5.8.4（已验证） |
| scheme | `workbuddy` | `workbuddy-ai` |
| 数据根 | `~/.workbuddy`（`WORKBUDDY_CONFIG_DIR` 可覆盖） | `~/.workbuddy-ai`（目录名来自 app 内 `cli/product.json` 的 `dataFolderName`；不吃 CN 的 env） |
| 国内版/国际版识别 | 各自 App bundle + 数据根目录 | 同左；**不用环境变量判断版本** |
| 安装判断 | 看 App bundle；数据目录存在不算已安装 | 同左 |
| 会话索引 | `workbuddy.db` 的 `sessions` 表（WAL） | 同左（结构一致：11 表 / 40 列 / 迁移 0017） |
| 消息流 | `projects/<编码cwd>/<id>.jsonl` | 同左；旧历史导入会话另有 `<id>.meta.json` 提供 cwd 兜底 |
| user 文本包装 | 外层 `<system-reminder data-role="…">`，内层以 `craft_mode` 等标签平铺，含 `<user_query>` | 同左外层包装，内层为 `user_info/identity_context/...` 平铺，含 `<user_query>` |
| 最后 user 消息 | 过滤 isMeta/isCompacted，优先 `startsNewUserRequest`，取 `<user_query>` | 规则相同（`isMeta/isCompacted` 字段在样本中不出现） |
| 完成状态 | `sessions.status`（completed/active/error/Pending）+ jsonl 末尾 assistant status；**无第三方佐证** | 同左（样本 completed；active/error 未验证） |
| 深链接 | `open "workbuddy://chat/<id>"`；已运行/冷启动/最小化均定位成功（每场景 n=1） | `open "workbuddy-ai://chat/<id>"`；普通会话冷/热/最小化/双会话互跳均成功；playground 冷启动 0/2（归因未证伪，保守置灰） |
| 失败判据 | `open` 恒 exit 0，失败=回首页；不存在 id 不调用 | 同左；`resetRouterToHome` 标记不可用（国际版日志从不写入） |

> 两个适配器已按本表事实落地（2026-10-19）：包路径、只读读取方式与合同映射见 §11。§11 只记录「代码怎么读」，不改变本节事实与依据等级。

### 0.2 只有本机逆向、没有第三方佐证的部分

- 完成状态、软删除、`transport`、`playground`、`unread` 都来自 `workbuddy.db`，**没有第三方实现佐证**（magpie 不读该库）；适配器必须做版本/schema 探测与降级。
- 消息解析规则（outer wrapper、合成消息标记）只有本机逆向 + 小样本；字段缺失按 §9.2/§9B.2 容错。
- 深链接无公开规范、也无第三方实现佐证（magpie 的 `Resume` 恒为空）；等级只能按本机实测。

### 0.3 未验证清单（最终）

`isMeta/isCompacted=true` 的实际形态、`status=active/error`、软删除正数时间戳、云端 `-1` 语义、三会话及以上深链互跳、已删除会话 id 的深链行为、playground 冷启动回落的归因。详见 §10.11。

## 1. 应用信息
> **两个独立工具，不是同一工具的变体**：本文档的适配对象是**国内版 WorkBuddy**（workbuddy.cn）。国际版 **WorkBuddy AI**（workbuddy.ai）是另一个独立工具（不同官网、文档、bundle、scheme、数据目录），**本期同样接入，作为并列的第三个独立适配器（`workbuddy-ai`）**，其调研与实测见 §9（观察）与 §10（本期实测），二者的结论、依据等级互不套用。

国内版 WorkBuddy（workbuddy.cn）：

| 项 | WorkBuddy.app |
|---|---|
| 路径 | /Applications/WorkBuddy.app |
| Bundle ID | com.tencent.workbuddy.mac |
| 版本 | 5.8.3 |
| URL scheme | `workbuddy` |
| 数据目录 | ~/.workbuddy |

- 国内版为 Electron（Contents/Frameworks/Electron Framework.framework），main 入口 `main/index.js`（打包于 app.asar，约 96MB）。
- 内核为 CodeBuddy（会话文件里有 `__codebuddyLocal`、`codebuddy.session_id` 等字段；还有 ~/Library/Application Support/CodeBuddyExtension）。
- 其它：~/Library/Logs/WorkBuddy（main.log/renderer.log）、Preferences/com.tencent.workbuddy.mac.plist；Application Support 下 com.tencent.workbuddy.mac / WorkBuddy 仅含遥测/桩数据，不含会话。

## 2. 数据位置与格式（以 ~/.workbuddy 为准）
- `~/.workbuddy/workbuddy.db`（SQLite，WAL 模式，另有 -wal/-shm）：会话元数据索引。读取时请连同 -wal/-shm 一起复制到 /tmp，或直接 `sqlite3 -readonly`（WAL 下只读打开可能仍需 -shm 写权限，建议复制）。
- `~/.workbuddy/projects/<cwd 编码>/<sessionId>.jsonl`：每个会话的完整消息流（JSONL，一行一事件）。目录名是 cwd 把 `/` 换成 `-` 并去掉首个 `/`，例如 `/Users/x/Desktop/tick` → `Users-x-Desktop-tick`。同目录还有 `<sessionId>.file-rollback.ndjson`、`<sessionId>/tool-results/`。
- `~/.workbuddy/sessions/<pid>.json`：运行中进程心跳，keys：cwd, kind, lastHeartbeat, pid, sessionId, startedAt, updatedAt（可用来判断「某会话当前是否有活跃进程」）。
- `~/.workbuddy/<userId>/sidebar-list-snapshot.json`（keys: items, savedAt, version）、`startup-route.json`（keys: path, savedAt）：UI 状态快照，不建议依赖。
- `~/.workbuddy/traces/<pid>/trace_*.jsonl`、`logs/`：追踪/日志，可选。
- 敏感文件（不要读）：keyblob、device-id、security/、settings.json、.workbuddy-key-fallback 等。

## 3. 会话/消息模型
### sessions 表（workbuddy.db）
主要列：`id`(TEXT PK, UUID)、`cwd`(NOT NULL，绑定工作目录)、`user_id`、`title`、`custom_title`、`status`、`created_at`/`updated_at`/`last_activity_at`(毫秒时间戳 INTEGER)、`deleted_at`(未删除为 -1 或 NULL，软删除为时间戳)、`unread`(0/1)、`mode`/`source_mode`(如 craft)、`transport`(local/cloud)、`is_background_automation`、`model`、`permission_mode` 等。
- 会话 ID：UUID，同时是 jsonl 文件名与深链接参数。
- 当前样本 status 取值：`completed`、`active`、`error`、（Pending 为默认值）。
- 过滤建议：`deleted_at IS NULL OR deleted_at = -1`（样本里 active 的那条出现了正数 deleted_at，需谅解为已删除/需再验证），`transport='local'`，`is_background_automation` 非 1。

### jsonl 事件
每行 JSON，`type` 取值：`session-meta`、`message`、`function_call`、`function_call_result`、`reasoning`、`file-history-snapshot`、`ai-title`。
- 公共字段：id、sessionId、cwd、timestamp、providerData（含 conversationRequestId、agent、model、traceId 等）。
- `type=message`：`role` ∈ {`user`,`assistant`}；`content` 为数组，元素 `{type:"input_text"|"output_text", text}`。assistant 消息带 `status` ∈ {`completed`,`incomplete`}（incomplete 伴随 providerData.error / skipRun）。
- 工具调用：独立的 `function_call` / `function_call_result`（无 role，result 有 status=completed），不是 role=tool。
- 系统/合成 user 消息（role 同样是 user，需过滤）：
  - `providerData.isMeta == true`：如 `<task-notification>` 后台任务通知；
  - `providerData.isCompacted == true`（isSummary/isCompactInternal）：上下文压缩摘要，文本以 `<cb_summary>` 开头；
  - 真实用户请求带 `providerData.startsNewUserRequest == true`。
- 真实 user 文本被包装：`<system-reminder>…<user_query>用户原文</user_query>…</system-reminder>`（还含 current_time、craft_mode、memory_and_skills_reminder、user_references 等标签）。提取原文需取 `<user_query>…</user_query>` 之间内容（正则非贪婪、DOTALL）。

## 4. 如何取最后一条 user 消息
1. 通过 workbuddy.db 找会话（id、cwd、status）→ 拼出 `projects/<编码cwd>/<id>.jsonl`（或遍历 projects/*/<id>.jsonl）。
2. 逐行解析（文件可能很大，数百~上千行，百 KB~MB 级；可 tac 倒读）。筛选：`type=="message" && role=="user" && providerData.startsNewUserRequest==true && !isMeta && !isCompacted`。
3. 取最后一条，`content[].text` 拼接后抽取 `<user_query>` 内文本；若无该标签则回退到整段并剥离 `<system-reminder>…</system-reminder>`。
4. jq 示例：
   `jq -c 'select(.type=="message" and .role=="user" and .providerData.startsNewUserRequest==true)' f.jsonl | tail -1`
- 注意：`startsNewUserRequest` 在样本中只出现在部分用户消息（7 条），其余为 isMeta；若字段缺失需要回退为「role=user 且非 isMeta 且非 isCompacted 且文本含 `<user_query>`」。

## 5. 如何判断完成
- 首选 DB：`sessions.status`：`completed` = 完成；`active` = 进行中；`error` = 失败（本次样本中 error 会话的 jsonl 仅 5 行）；`Pending` = 未开始。`unread` 表示有未读结果。
- 辅助（jsonl）：末尾事件为 `message/assistant/status=completed` 且之后无 function_call，视为本轮完成；末尾是 function_call/function_call_result 表示仍在执行；assistant `status=incomplete` + error 表示中断/出错。
- 辅助（进程）：`~/.workbuddy/sessions/<pid>.json` 的 lastHeartbeat 新鲜（且 pid 存活）表示会话仍有活跃进程。
- 注意：DB 是 WAL，数据写入延迟；status 与 jsonl 末尾可能短暂不一致，建议两者结合并加轮询去抖（如 updated_at 静默 N 秒）。
- 「当前最后一条 user 之后是否已有 assistant completed」可作为 Ticktodo「任务完成」的稳妥判据。

## 6. 拉起与定位
- 自定义 URL scheme：`workbuddy://`（国内版 WorkBuddy.app）。国际版 WorkBuddy AI 的 scheme 见 §9/§10（独立适配器 `workbuddy-ai`，深链接未验证）。
- 从 app.asar 字符串分析（未执行）到的深链接：
  - `workbuddy://chat/<encodeURIComponent(sessionId)>[?query]` —— 打开指定会话（应用内通知点击、托盘 navigateToSession 都用它）；
  - `workbuddy://home` —— 回主页；
  - `workbuddy://automation/run?v=1&automationId=..&recordId=..` —— 自动化运行记录；
  - `workbuddy://agentmail[/admin]`。
- 处理链路：macOS `open-url` → `WindowManager.handleOpenUrl(url)`：先 `showOrCreate()` 显示/创建主窗口，再向渲染进程广播 `app:openUrl`。因此：应用未运行时会冷启动并（渲染就绪后）处理；已运行时直接前置并跳转。另有 Electron 单实例（SingletonLock），第二实例会转发到已运行实例。
- 推荐方案：`open "workbuddy://chat/<sessionId>"`（可选再 `osascript -e 'tell application "WorkBuddy" to activate'` 兜底前置）。**本次未实际执行**（应用当前正在运行，且会改变前台窗口/用户可见状态），上线前需在非关键时刻验证：已运行/未运行两种情形、会话已删除时的表现、是否需要同一 cwd 的 workspace 已打开。
- 其它备选：命令行参数未发现专用 `--session` 参数（未深查）；AppleScript 无字典，仅能 activate；不推荐 UI 脚本。

## 7. 风险与建议
- 内部格式无公开契约：jsonl/DB schema 随版本（5.8.x）变化，需做字段容错并带版本探测（Info.plist 版本 + migrations 目录 `.workbuddy-sqlite-migrations`）。
- 国际版 WorkBuddy AI 是独立工具，不与国内版共用适配器配置；国际版为本期并列的独立适配器 `workbuddy-ai`，单独验证（见 §9、§10）。
- 敏感数据：同目录下有 keyblob/settings/认证文件，适配器只应读 workbuddy.db 与 projects/*.jsonl，且 user 文本进入 Ticktodo 前建议截断/脱敏（wrapper 中含系统提示、记忆、路径）。
- 读取并发：应用运行时 DB 处于 WAL，务必只读（`-readonly` 或 immutable 复制）；jsonl 追加写，按行读取容忍末行半行。
- 会话删除为软删除（deleted_at），jsonl 可能仍在，需用 DB 过滤。
- 文件监听：可对 projects/<cwd>/<id>.jsonl 做 mtime/大小轮询替代全量解析；自动化/后台会话（is_background_automation）应排除。
- 建议适配器接口：listSessions()（DB）→ lastUserMessage(id)（jsonl）→ isDone(id)（status + jsonl 末尾）→ open(id)（`open workbuddy://chat/<id>`）。深链接定位需在真机验证后再落地。（以上均针对国内版。）

## 8. 深链接实测 + 官方文档核对（2026-10-18 16:35–16:40 UTC+8，WorkBuddy 5.8.x）

### 8.1 实测环境与方法
- 测试前：WorkBuddy 主进程**未运行**（仅有 editor_sdk、browser-extension-native-host 两个辅助进程；注意主进程名是 `Electron`，不是 `WorkBuddy`，`System Events` 里 `process "WorkBuddy"` 取不到）。前台应用 Google Chrome。
- **Mac 处于锁屏状态**（CGSSessionScreenIsLocked=true，HID 空闲约 43 分钟）→ `screencapture` 只截到锁屏壁纸（本地截图），**无法用截图/窗口标题验证**。改用应用自身日志验证（~/.workbuddy/logs/main.log、renderer.log、日期目录下 sdk/conversations/*.log），日志只含 URL 元数据、路由，不含会话正文。
- 测试会话（local，非删除、非后台自动化）：A=<session-id-A>（最老，示例会话）；B=<session-id-B>（较新，completed）。

### 8.2 逐项结果
1. **冷启动（意外覆盖，应用本就未运行）** `open "workbuddy://chat/<session-id-A>"`：应用被拉起；main 日志 `[DeepLink] stored until WindowManager ready` → 约 1.7s 后 `dispatching open url to renderer`（scheme=workbuddy, host=chat, pathname=/<id>）→ renderer 写入 pending store；SDK 随后为该 id 建立会话实例（`lifecycle:created conversationId=<session-id-A>`）。路由日志显示 `/` → `/conversation/<restored-session-id>…`(应用恢复的上次会话) → `/conversation/<session-id-A>`，即**最终定位到了目标会话**。冷启动场景因此有一次真实观测（但非“用户未保存状态”风险场景：启动时应用本来就没运行）。
2. **热启动，另一会话 B** `open "workbuddy://chat/<session-id-B>"`：路由 `/conversation/<session-id-A> → /conversation/<session-id-B>`，SDK 日志出现 `get conversationId=<session-id-B>`；**确认切换到指定会话**，不是保持原状。
3. **不存在的随机 UUID**（<random-uuid>）：深链被正常分发；路由先到 `/conversation/<random-uuid>…`，SDK 请求 `GET /console/as/conversations/:id` 返回 **404**（`cloud.http.detail.request_failed httpStatus=404`，生成 -warning.log），约 0.2s 内路由**自动回退到 `/`（首页）**。表现：无报错弹窗证据（未能目视确认，锁屏），但行为是“落到首页”，不会停在空白会话。适配器应把“落首页”视为失败，需先用 DB 校验 id 存在。
4. 注意：深链对 id 的存在性不做同步校验，也无返回码（`open` 总是 exit 0），无法从命令结果得知是否成功。
- **未验证**：可见窗口前置/窗口标题（锁屏所致，需用户解锁后目视复测）；“应用已运行且在后台/最小化”时的前置行为；删除（deleted_at）会话 id 的行为；云端会话（transport=cloud）。
- 实测后已 activate Google Chrome 恢复前台（锁屏下无可见变化）。WorkBuddy 是因本次测试被拉起的，当前仍在运行（原本未运行），未强制关闭以免影响用户。
- 附带发现：会话 DB 的 `sessions.deleted_at` 非删除值可能为 NULL 或 -1/0，过滤条件用 `deleted_at IS NULL OR deleted_at<=0`；主进程名 `Electron`；日志 `[DeepLink]` 前缀可用于验证。

### 8.3 官方文档核对（只列实际查到的）
- WorkBuddy 官网文档：https://www.workbuddy.cn/docs/workbuddy/Changelog （更新日志，含 5.8.2 / 2026-10-16）、任务管理 https://www.workbuddy.cn/docs/workbuddy/Task-Management 、创建任务 https://www.workbuddy.cn/docs/workbuddy/Create-Task 、项目 https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Project 、企业智能体 …/CloudAgent。
- **深链接**：官方只在更新日志中提及能力，**没有公开 scheme/路径/参数规范**：5.1.0（2026-06-13）“新增页面 deeplink 直达导航，支持外部链接一键打开任务/项目/待办”；5.3.7 “修复 Deeplink 跳转时工作目录未正确设置”；5.3.11 “资料库支持 deeplink 打开指定文档”；5.3.12 “修复专家深链在冷启动期间无法打开专家详情”；4.22.15 “修复外部协议链接偶发错误唤起 WorkBuddy”。→ 说明深链为产品功能且持续修复（含冷启动问题），但无稳定性承诺。第三方（非官方）https://github.com/ZhaoXiangyu99/workbuddy-mcp 记录 `workbuddy://home`、`workbuddy://chat/<id>`、`workbuddy://my-files?tab=cloudFiles` 仅做 UI 导航，不能提交任务，与我们的结论一致。
- **会话/任务状态**（Task-Management）：官方 UI 状态：进行中/已完成/失败/待处理/规划中/已归档；侧栏标记：进行中、已完成未读、待确认。与 DB `status`（completed/active/error/Pending）+ `unread` 大体对应，但官方未公开 DB 字段枚举。
- **未找到**：WorkBuddy 官方对本地会话存储（~/.workbuddy/workbuddy.db、projects/*.jsonl）格式的公开说明/导出规范/CLI 参数文档；官方 changelog 仅提到“transcript / replay 写入策略优化”(5.0.2)、“数据库 WAL 修复/静默丢失检测”(5.1.0/5.1.1)、“历史会话迁移”“会话历史索引损坏”(4.10.4) ——即存储实现会变且有迁移，**无向后兼容承诺**。5.3.5 “WorkBuddy 扩展插件 Hook”仅一行，无细节文档。
- CodeBuddy Code 公开文档（同一内核，我们可借鉴）：
  - 目录结构 https://www.codebuddy.ai/docs/cli/codebuddy-dir ：`~/.codebuddy/{settings.json, projects/, sessions/, history.jsonl, logs/, blobs/, plugins/, ...}`；`projects/` = “每项目会话记录(.jsonl)及子 agent 工具输出”，官方称为自动维护的运行时数据，**不建议手动操作**，未承诺格式。
  - Hooks https://www.codebuddy.ai/docs/cli/hooks 、https://www.tencentcloud.com/document/product/1316/84468 ：配置在 ~/.codebuddy/settings.json、<proj>/.codebuddy/settings.json(.local.json)；hook stdin JSON 含 `session_id, transcript_path, cwd, permission_mode, hook_event_name`（transcript_path 形如 ~/.codebuddy/projects/…/<uuid>.jsonl）；事件含 SessionStart(startup/resume/clear/compact)、SessionEnd(clear/logout/prompt_input_exit/other)、PreToolUse/PostToolUse 等。→ **这是官方公开且相对稳定的“拿 session_id + transcript 路径”的接口，建议优先作为 Ticktodo 的完成/活跃信号源（若 WorkBuddy 内核同样支持 hook，需实测）**。
  - HTTP/ACP API（Beta）https://cloud.tencent.com/document/product/1831/137064 ：`GET /api/v1/sessions?cwd=*`、`DELETE /api/v1/sessions/:id`、`POST /api/v1/sessions/:id/rename`；公开 REST API 承诺“语义化版本，不做破坏性变更”，`/internal/*` 不保证兼容。属于 CodeBuddy Code 服务模式，非 WorkBuddy 桌面端。
  - 远程控制 /gateway https://cloud.tencent.com/document/product/1831/137049 （Beta）。
  - 企业版 CreateAgentSession API https://cloud.tencent.com/document/product/1831/138630 （云端企业智能体会话，非本地）。
- jsonl 记录格式：**官方文档未给出**。第三方实现一致：https://github.com/xintaofei/codeg/blob/main/src-tauri/src/parsers/codebuddy.rs 、https://vshulcz.github.io/deja-vu/registry/codebuddy.html ：路径 `${CODEBUDDY_CONFIG_DIR:-~/.codebuddy}/projects/<cwd 编码>/<id>.jsonl`，每行 OpenAI Responses 风格 item：type∈message/reasoning/function_call/function_call_result/summary/ai-title/custom-title/topic/turn-metrics/file-history-snapshot/session-meta；message 有 role、content[](input_text/output_text)、assistant `status:"completed"`；时间戳为毫秒 epoch，记录带 cwd；cwd 编码规则为 `/ \ :` 替换为 `-` 并去掉开头的 `-`。deja-vu 还记载国内版 WorkBuddy 为 `~/.workbuddy/projects/…`，布局与记录与 CodeBuddy 相同；其另行提到的 `$WORKBUDDY_CONFIG_DIR` 仅为第三方说法，本机未验证，且不据此推断国际版（国际版见 §9）。该页同时提到 workbuddy.ai 的 `~/.workbuddy-ai`，属另一工具，本文不引用其格式结论。

### 8.4 与已知字段的差异/补充
- 一致：目录布局、jsonl 为 Responses item、message/role/status=completed、毫秒时间戳、国内版目录 `~/.workbuddy`。
- 官方/第三方提到而我们未覆盖的 type：`custom-title`、`topic`、`turn-metrics`、`file-history-snapshot`、`session-meta`、`ai-title`（解析应忽略未知 type）；`CODEBUDDY_CONFIG_DIR`/`WORKBUDDY_CONFIG_DIR` 环境变量可改根目录（仅第三方说法、仅针对国内版、本机未验证；适配器根目录建议可配置，仅作用于国内版）。
- WorkBuddy 特有而 CodeBuddy 文档无：workbuddy.db(sessions 表、unread、is_background_automation、transport local/cloud)、`providerData.startsNewUserRequest/isMeta/isCompacted`——均**无官方文档，仅本机逆向**，视为内部格式。
- CodeBuddy 官方 hook 的 `transcript_path` 与我们的 jsonl 路径规则相同，可互相印证。
- 结论：深链接可用但属“有功能、无规范”；存储格式无官方承诺。建议：适配层加版本探测与容错；`open workbuddy://chat/<id>` 前先校验 id 存在于 DB（无效 id 会落首页且不报错）；用户解锁后目视复测窗口前置。

### 8.5 解锁后目视复测（2026-10-18 16:41 UTC+8，WorkBuddy 5.8.3 界面显示 v5.8.3）
- 会话选取：A=<session-id-A>（示例会话 A），B=<session-id-B>（示例会话 B）；均 deleted_at 非删除、local、非后台自动化。DB `sessions` 有 `title`/`custom_title` 字段，可直接取标题。
- 前置状态：前台 Google Chrome；WorkBuddy 主进程可执行名 `Electron`（`/Applications/WorkBuddy.app/Contents/MacOS/Electron`），运行态 **bundleID = `com.tencent.workbuddy.mac`** 已运行，窗口 1 个。`pgrep -fl WorkBuddy` 能匹配到完整路径含 WorkBuddy.app 的进程。**修正（2026-10-19 复核）：`lsappinfo` 对同一进程（pid 4408，启动于 10-18 16:36:29）报 `com.tencent.workbuddy.mac`；`com.github.Electron` 是 Electron 框架默认值，本机属于 Tick 的 dev Electron，不能作为 WorkBuddy 的判据。**
- 测试1（先激活 Finder，再 open A，等 4s）：前台变为 WorkBuddy（bundleID=`com.tencent.workbuddy.mac`）；截图确认 WorkBuddy 窗口在最前，顶部会话标题=“示例会话 A”，与 A 一致。
- 测试2（先激活 Finder，再 open B）：同样前置；窗口标题=“示例会话 B”，侧栏高亮 B，与 B 一致。
- 测试3（AXMinimized=true 最小化后 open A）：最小化后前台仍是 WorkBuddy（bundleID 同上）；open 后窗口 AXMinimized 变 false、窗口恢复并前置，标题回到“示例会话 A”。
- 注意：System Events 窗口名恒为 “WorkBuddy”，会话标题是应用内标题栏，不在 AX 窗口名中，验证需截图。判断前台应用用 bundleID `com.tencent.workbuddy.mac` 或可执行路径 `/Applications/WorkBuddy.app/Contents/MacOS/Electron`；**进程名 `Electron` 不能用于区分**（两版同名）。
- 测后已激活 Google Chrome 恢复前台。本节截图仅存本机临时目录（含会话标题），复核后已删除；仓库内不含任何截图。

## 9. 国际版 WorkBuddy AI（workbuddy.ai）——独立工具（初次只读观察；本期实测见 §10）
> 定位：与国内版 WorkBuddy 是**两个独立工具**。（原“后续”已升为本期 P0 独立适配器，见 §10。）以下仅为本机只读观察与官网文档核对（2026-10-18），**其 scheme / 目录 / 数据格式均未经充分验证，不得套用 §2–§8 的国内版结论**。未修改任何应用配置，未读取会话/密钥内容，未执行 open / 深链接。

### 9.1 首轮本机只读观察（已被 §10 补测；最终见 §10.11）
| 项 | 观察值 | 等级 |
|---|---|---|
| 应用 | /Applications/WorkBuddy AI.app，CFBundleName/DisplayName = `WorkBuddy AI` | 仅本机观察 |
| Bundle ID | `com.workbuddy.workbuddy-ai`（Info.plist） | 仅本机观察 |
| 版本 | 5.8.4（Info.plist；与 workbuddy.ai 官方 Changelog 的 5.8.4 条目版本号一致） | 仅本机观察 + 官网佐证版本号 |
| URL scheme | `workbuddy-ai`（Info.plist 的 CFBundleURLTypes，URLName=`WorkBuddy AI Deep Links`）；路径/参数已在 §10.5+ 实测 | 仅本机观察；已补测 |
| 数据目录 | `~/.workbuddy-ai` 存在；含 `workbuddy.db`、`.workbuddy-sqlite-migrations`、`sessions/`、`projects/`（产生会话后）；表结构与 jsonl 已在 §10.8+ 实测（11 表 / 40 列 / 迁移 0017） | 仅本机观察；已由 §10.8+ 补测 |
| 根目录/版本识别 | 两 build 各自独立 App bundle + 数据根目录；`WORKBUDDY_CONFIG_DIR` 只属国内版；国际版目录来自 `product.json` 的 `dataFolderName` | 第三方实现佐证（[M] magpie）+ 本机目录 |

### 9.2 官网文档核对（workbuddy.ai）
- 官网 https://www.workbuddy.ai/ 为国际版页面（页面内含 `IS_INTERNATIONAL_EDITION = 'true'` 标记）；文档站 https://www.workbuddy.ai/docs/workbuddy/ （Quickstart、Changelog 等）。
- Quickstart：产品名 Tencent WorkBuddy，桌面端 AI agent；登录使用 Google / GitHub OAuth（国内版文档为另一套账号体系，不可互套）。
- Changelog：含 5.8.4、5.7.6、5.6.2 等条目；**未见 deeplink、会话存储格式、hooks 的任何说明**。
- Tencent Cloud International 的 WorkBuddy 产品/文档页（intl.cloud.tencent.com）为企业版文档，与桌面端本地存储无关。
- 结论：国际版**没有**公开的 scheme、数据目录、数据格式规范；其 deeplink、会话存储是否与国内版一致**未验证**。
- 独立适配器前置项（本期实测见 §10，仍未完成部分）：独立验证 scheme 与路径、`workbuddy.db`/jsonl 格式、完成状态字段、前台进程名；单独建立依据表。

## 10. 国际版 WorkBuddy AI 本期实测（2026-10-18 17:36–17:50 UTC+8，5.8.4）——独立适配器 `workbuddy-ai`

> ⚠️ §10.1–§10.10 为**逐轮实测记录（历史）**，其中“无会话/未验证/无 -wal/-shm/单文件”等表述已被后续轮次取代；**最终结论见 §0 与 §10.11**，PRD 按 §10.8/§10.9/§10.10 引用具体轮次。

> 不得与 §2–§8（国内版）混用。全程只读：db 复制到临时目录后以 `mode=ro` 打开；未读取会话标题/内容/ID，也未读 keyblob/settings。文档不含任何会话标题/ID/截图路径。

### 10.1 实测环境
- 应用：`/Applications/WorkBuddy AI.app`，bundle `com.workbuddy.workbuddy-ai`，5.8.4，可执行名 `Electron`；Info.plist `CFBundleURLSchemes = workbuddy-ai`（URLName `WorkBuddy AI Deep Links`）。
- 首轮（17:36–17:50）：应用未运行、屏幕锁定，深链接未测；18:00 补测见 §10.5（屏幕已解锁）。

### 10.2 数据库（只读）
- `~/.workbuddy-ai/workbuddy.db`：首轮 0 会话时未见 `-wal`/`-shm`；**有会话后为 WAL**（db + `-wal` + `-shm`，§10.8 实测）。表：`sessions`、`workspaces`、`automations`、`automation_runs`、`automation_runtime_state`、`automation_delivery_outbox`、`migration_meta`、`session_usage`、`buddy_snapshots`、`workspace_trust_decisions`、`__workbuddy_drizzle_migrations`（**无** `cloud_conversations` 表，已在迁移 0012 合并进 `sessions`）。
- `sessions` 共 40 列：id、cwd、user_id、title、custom_title、status、created_at、updated_at、last_activity_at、deleted_at、is_playground、source_mode、is_background_automation、mode、model、expert_*、permission_mode、use_sandbox_cli、project_id、plugin_context_json、addon_selection、session_settings、last_user_prompt_expert_selection、context_window、buddy_*、thought_level、transport、conversation_origin、visibility、group_id、group_title、agent_dirty*、verified_at、unread。
- **会话数量：0**（`sessions` 0 行、`session_usage` 0、`workspaces` 0）。迁移脚本最新 0017；`status` 默认 `Pending`，`deleted_at` 可空，`transport` 默认 `local`，`unread` 默认 0。
- 注意：首轮（db 无 `-wal`/`-shm`）用 `sqlite3 -readonly` 会报 “unable to open database file”——这是 **WAL 库在 `-wal`/`-shm` 不存在时只读打开的限制**（SQLITE_CANTOPEN），**不是环境问题**；有 `-wal`/`-shm` 后 CLI 与库 API 均可 `mode=ro` 读取（§10.8；2026-10-19 复核）。适配器仍应以库 API 读取并处理打开失败。

### 10.3 会话记录位置
- 首轮（0 会话）`~/.workbuddy-ai/projects/` 不存在、`*.jsonl` 0 个、`sessions/` 无心跳；产生会话后（§10.8）出现 `projects/<编码cwd>/<id>.jsonl` 与 `sessions/<pid>.json` 心跳。
- 结论（历史）：首轮无会话，无法验证消息流；§10.8 起已实测（最终见 §10.11）。

### 10.4 与国内版逐项对照
| 项 | 结果 |
|---|---|
| sessions 表存在及核心列（id/cwd/title/custom_title/status/时间戳/deleted_at/transport/is_background_automation/unread） | **一致**（已实测） |
| 迁移机制 `.workbuddy-sqlite-migrations`、drizzle 迁移表 | 一致（国际版最新 0017，国内版另有差异未逐项比对） |
| 表集合 | 国际版无独立 `cloud_conversations` 表（合并入 sessions）；国内版未做逐表对照，**不下结论** |
| role=user、`user_query` 包装、`isMeta`/`isCompacted`/`startsNewUserRequest` | 首轮未验证；§10.8+ 已核对：规则与国内版一致，**两版都有外层 wrapper**，仅内层标签不同 |
| status 完成判定（completed/active/error） | 首轮未验证；§10.8+ 样本为 `completed`（`active/error` 仍未验证） |
| deleted_at 语义 | 首轮未验证；§10.8+ 未删除本地会话为 NULL（云端 `-1` / 正数软删仍未验证） |
| 主进程名 | 可执行名 `Electron`，与国内版同；前台 bundle 已实测 `com.workbuddy.workbuddy-ai`（§10.9/§10.10） |

### 10.5 深链接（2026-10-18 18:00 UTC+8 补测，屏幕已解锁，IOConsoleLocked=No）
- 前提：`sessions` 表 0 行，**无真实会话可测**；故未测 `chat/<真实id>`。本节未保存截图（临时文件 2026-10-19 已清理）。判断依据：`lsappinfo` 前台 bundle id、System Events 窗口名、应用 main/renderer 日志中的 `[DeepLink]` 与路由变化。
- **冷启动 `workbuddy-ai://home`**（应用未运行）：拉起应用；主进程日志先 “stored until WindowManager ready”，窗口就绪后分发到渲染进程；窗口标题 `WorkBuddy AI`，前台 bundle id `com.workbuddy.workbuddy-ai`。
- **热 `workbuddy-ai://home`**（已运行，含前台切到 Finder 后再调用）：重新前置应用，路由 `/home`，前台 bundle id 同上。
- **`workbuddy-ai://chat/00000000-0000-0000-0000-000000000000`（不存在）**：被分发，渲染进程路由切到 `/conversation/<该id>`（activePanelView=conversation）。一次观测约 1 秒后回落 `/`（首页）；另一次在被下一条 home 覆盖前停留了数秒。结论：行为不稳定（空会话页或回落首页），`open` 恒 exit 0，无法得知成败，故调用前必须由 DB 校验 id 存在。
- **`chat/<真实id>`：未验证**（无会话）。
- **`workbuddy-ai://` 未被忽略**（此前静态检索无字面量的担忧排除）。System Events 的进程名为 `Electron`，与国内版重名，区分须用 bundle id。
- 结论（历史）：`home` 通过；当时无真实会话，故“回到会话”未验证。最终结论：真实会话定位已在 §10.9/§10.10 实测通过，普通会话“回到会话”**默认开启**，playground 会话保守置灰（见 §10.11）。
- 另：两个 build 以各自的 App bundle / 数据根目录独立区分（`workbuddy` / `workbuddy-ai`），**不用 `WORKBUDDY_CONFIG_DIR` 判断版本**；该变量只作国内版根目录覆盖（[M] magpie 两 build 各注册独立 agent；旧的「app 以 env 是否含 `workbuddy-ai` 判断 overseas/cn」为逆向字符串，已不采用）。

### 10.6 官网文档（workbuddy.ai，只读）
- Changelog（https://www.workbuddy.ai/docs/workbuddy/Changelog ）：5.8.4、5.7.6、5.6.2、5.5.0、5.2.7、5.2.3；**无** deeplink/scheme、本地存储格式、hooks 的说明；仅 5.8.4 提到“Scheduled task status, recovery, notifications, and result navigation”、“Large or malformed history records preventing conversations from opening”（说明历史记录格式会变/有损坏情形）。
- Quickstart：登录用 Google/GitHub OAuth（见 §9.2）。官方无存储/深链/hooks 规范。

### 10.7 首轮未验证清单（已被 §10.8+ 补测；最终未验证见 §10.11）
首轮未验证：jsonl 格式与全部消息规则、`status`/`deleted_at` 语义、真实会话 `chat/<id>` 深链接、hooks、根目录行为。§10.8+ 已补大部分；残余见 §10.11。

### 10.8 第二轮实测（2026-10-18 18:05–18:10 UTC+8，5.8.4，已有 1 个真实本地会话，屏幕已解锁 IOConsoleLocked=No）

> 全程只读 + 深链接/退出重启应用；未发消息、未改配置、未读 keyblob/settings。**本节与文档均不含会话标题/id/截图路径**（未保存截图）。样本仅 1 个会话（1 轮问答）。

**数据库**
- `file:…?mode=ro&immutable=1` 打开：`sessions` **0 行**；原因：库为 WAL，新会话仅在 `-wal`（8 KB，db 本体 188 KB），immutable 模式忽略 -wal。把 db 与 -wal 复制到临时目录后以普通方式读取：**1 行**。→ 适配器不得用 immutable=1（PRD §9B.1）。
- 该行：`status=completed`，`deleted_at=NULL`，`transport=local`，`is_background_automation=NULL`，`is_playground=1`，`source_mode=mode=craft`，`permission_mode=bypassPermissions`，`unread=0`；`created_at < last_activity_at ≤ updated_at`（毫秒）；`id` 与 jsonl 文件名一致。

**会话记录**
- 位置：`~/.workbuddy-ai/projects/<cwd 编码>/<id>.jsonl` + `<id>.file-rollback.ndjson`。cwd 编码把 `/` 换成 `-`、去首个 `-`，**空格保留**。
- `~/.workbuddy-ai/sessions/<pid>.json` 是应用侧会话心跳；本机复核（2026-10-19）为 `kind=interactive`、sessionId 是真实会话 id 且存在于 `sessions` 表（**不是**「仅预热」/`prewarm-`）。心跳新鲜只表示应用当前打开/预热了该会话，**不等于正在执行**（该会话 `status=completed`），可作辅助信号，不能当完成判据。
- 事件 `type`：`session-meta`（×2，`meta` 含 hostKind）、`message`、`file-history-snapshot`、`ai-title`；共 6 行。`message` 含 `role`、`content[{type:"input_text"|…,text}]`；assistant 带 `status`。

**与国内版逐项对比**
| 项 | 国内版 | 国际版（本轮） |
|---|---|---|
| jsonl 路径/文件名结构 | `projects/<编码cwd>/<id>.jsonl` | 一致 |
| `type=message`、`role=user/assistant` | 是 | 一致 |
| user 文本包装 | 外层 `<system-reminder data-role="…">` 内含 `<user_query>` | **同样有外层 `<system-reminder data-role="…">` 包装**（2026-10-19 复核 4/4 真实 user 请求）；内层标签平铺：`user_info/identity_context/product_identity/project_context/project_layout/current_time/memory_and_skills_reminder/user_query`；标签带属性，不能用无属性字面量匹配 |
| `startsNewUserRequest` | 真实用户请求为 true | 一致（样本为 true） |
| `isMeta` / `isCompacted` | 合成消息带标记 | 样本中**均未出现**，语义未验证 |
| 末尾 assistant `status` | `completed`/`incomplete` | `completed`（一致） |
| `sessions.status` | completed/active/error/Pending | 样本 `completed`；其余未验证 |
| `deleted_at` | NULL/-1 未删除，正数软删除 | 样本 NULL；其余未验证 |
| 最后 user 消息提取规则 | 筛 `startsNewUserRequest`，取 `<user_query>` | **规则一致可用**，仅内层标签不同（只验证了规则，内容未入文档） |

**深链接（真实会话 id）**——判据：渲染进程日志 `cloudProjection` 路由差异、主进程 `[DeepLink]`、`lsappinfo` 前台 bundle id；System Events 窗口标题恒为 `WorkBuddy AI`，不能区分会话。**`resetRouterToHome` 不是可用判据**（2026-10-19 复核：该标记在国际版全部日志中 0 次，同期 `[DeepLink]` 332 条、`cloudProjection` 159 条）。
| 场景 | 次数 | 结果 |
|---|---|---|
| 热启动，先停在 home / 先切到 Finder | 5 | 4 次稳定定位 `/conversation/<id>`（前台 `com.workbuddy.workbuddy-ai`）；1 次（首次）约 100ms 后路由回首页 |
| 冷启动（先退出应用） | 2 | 2 次均：主进程 “stored until WindowManager ready”→分发→路由短暂到会话页→回首页 |
- 结论（历史，仅 playground 样本）：热启动大多可定位，冷启动 0/2，归因未证伪；`open` 恒 exit 0。**该结论不适用于普通会话**——普通会话见 §10.9（冷 6/6）/§10.10，最终见 §10.11；不降级到 `workbuddy://`。
- 仍待查：冷启动回落首页的原因（疑似渲染端会话列表未就绪时被重置）、热启动偶发回落的触发条件、最小化、已删除 id。

### 10.9 第三轮实测：普通会话深链接矩阵（2026-10-18 18:49–19:25 UTC+8，5.8.4，屏幕已解锁 IOConsoleLocked=No）

> 只读 DB（复制 db/-wal/-shm 到临时目录再查）+ 深链接/退出重启应用；未发消息、未改配置。**不含会话标题/id/截图路径**。此时库里有 2 个会话：1 个 `is_playground=1`，1 个 `is_playground=0`（普通，`status=completed`，`deleted_at=NULL`，`transport=local`，`source_mode=mode=craft`）。渲染日志 `conversationsLength=1`（应用侧只列出普通会话，playground 不计入）。

**方法**：每次先退出应用；再预置“上次会话”为另一个会话（冷启动一次后退出），避免把“应用自动恢复上次会话”误判成深链接成功（对照：纯 `open -a` 不发链接 3/3 恢复到预置会话，不是目标）。判据：渲染日志 `cloudProjection` 路由最终为 `/conversation/<目标>` 且观察 ≥10 秒内无再变化；`[DeepLink]` 主进程日志；`lsappinfo` 前台 bundle id。

| 策略 | 次数 | 成功 | 说明 |
|---|---|---|---|
| 基线：冷启动 `open` 一次 | 6（另有 6 次因中途锁屏/前台被占而在解锁后重跑，以重跑为准） | 6/6 | 约 0.2s 内先恢复预置会话、随即切到目标，稳定 |
| A：`open` 后 2s 补发 | 3 | 3/3 | 补发为幂等，无副作用 |
| A：4s 补发 | 3 | 3/3 | 同上 |
| A：8s 补发 | 3 | 3/3 | 同上 |
| B：`open -a` 等 `Registered: deeplink` 再 `open` | 3 | 3/3 | 就绪信号约 0.5s 内出现 |
| B：固定等 3s | 3 | 3/3 | |
| B：固定等 6s | 3 | 3/3 | |
| C：监测路由回落并补发 | 3 | 3/3 | 12s 内**路由回落 0 次**，无需补发（`resetRouterToHome` 标记在国际版日志中 0 次，不能作判据） |
| 热启动（应用已在首页运行后 `open`） | 3 | 3/3 | |
| 最小化后 `open` | 1 | 1/1 | |

全部：观察窗口内无路由回落（`resetRouterToHome` 不可作判据，见 §10.8），前台 bundle id `com.workbuddy.workbuddy-ai`。**结论**：对普通会话，单次 `open` 即稳定，补发/延迟均无增益；§10.8 的冷启动回落很可能与“目标是 playground 会话”有关（假设，未对 playground 复测以免改动状态；仅另测到对 playground 会话的 `open` 也能切到其路由，但与恢复行为混淆，不作结论）。

**普通会话字段核对**（不含正文/标题/id）：`status=completed`；`deleted_at=NULL`（未软删除；索引条件里的 `-1` 是云端会话用法，本地会话未见）；`is_playground=0`；jsonl 中 `isMeta`/`isCompacted` 字段均不出现（缺省），出现 `function_call`/`function_call_result`（各 12，result 的 `status=completed`），assistant `message` 4 条 `status=completed`。`active/error/软删除/isMeta=true` 仍未验证。

### 10.10 第四轮实测：多普通会话深链接复测（2026-10-18 19:33–19:42 UTC+8，5.8.4，屏幕已解锁 IOConsoleLocked=No）

> 只读 DB（复制 db/-wal/-shm 到临时目录）+ 深链接/退出重启；未发消息、未改配置。**不含会话标题/id/截图路径**（文中用占位符 `<A>`/`<B>`）。

**库快照**：`is_playground!=1` 且 `deleted_at IS NULL` 的普通会话 **2** 个，status 分布：`completed`×2。另有 playground 会话 2 个（不参与本轮）。样本不足 3，故无 `<C>`；**未测** `B→C` / `C→A`。

**方法**：每次冷启动先 `open` 到预置会话再 quit，再 `open "workbuddy-ai://chat/<目标>"`，避免把“自动恢复上次会话”判成深链接成功。判据同 §10.9：渲染日志 `cloudProjection` 最终 `pathname=/conversation/<目标>`，观察 ≥10 秒内无路由回落（`resetRouterToHome` 不可作判据，见 §10.9），前台 bundle id=`com.workbuddy.workbuddy-ai`。

| 场景 | 次数 | 成功 | 说明 |
|---|---|---|---|
| 冷启动：预置 `<A>` → 深链 `<B>` | 2 | 2/2 | 约 1.6s 内落到 `<B>`；路径序列含短暂预置恢复再切目标；观察窗口内无回落 |
| 冷启动：预置 `<B>` → 深链 `<A>` | 2 | 2/2 | 对称成功 |
| 热启动：已运行且停在 `<A>` → 深链 `<B>` | 3 | 3/3 | 约 0.4–1.2s；观察窗口内无回落 |

**结论**：多普通会话（2 个样本）下，跨会话冷/热定位与 §10.9 单普通会话结论**一致**——单次 `open` 即稳，无需补发/延迟。国际版“回到会话”**保持默认开启**（仅 `is_playground!=1` 且未删除）；playground 仍置灰。样本限制：同机、5.8.4、**2 个**普通会话；第三会话方向未测。

**jsonl 只读抽查**（2 个新普通会话，字段级，无正文入档）：均与 §10.8 一致——`type=message` + `role=user/assistant`；user 含 `<user_query>`；`providerData.startsNewUserRequest=true`；末尾 assistant `status=completed`；**`isMeta`/`isCompacted` 字段仍不出现**（缺省）。其中一个会话另含 `function_call`/`function_call_result`（与 §10.9 普通会话字段核对一致）。`isMeta=true` / `active` / 软删除仍未验证。

### 10.11 国际版最终结论（以本节为准；2026-10-19 复核）

- **数据源**：`~/.workbuddy-ai/workbuddy.db`（WAL）的 `sessions` 表 + `projects/<编码cwd>/<id>.jsonl`；结构与国内版一致（11 表 / 40 列 / 迁移 0017）；旧历史导入会话的 cwd 可从 `<id>.meta.json` 兜底。
- **读取配方**：优先 live `mode=ro`（本机可用）；失败再复制 db + `-wal`（有则 `-shm`）到临时目录、以普通读写方式打开副本；**禁用 `immutable=1`**（忽略 -wal）；副本用完立即删除。
- **user 文本**：两版都有外层 `<system-reminder data-role="…">` 包装；抽取 `<user_query>`；正则必须容忍属性，不能用无属性字面量匹配。
- **完成状态**：`sessions.status` + jsonl 末尾 assistant `status`；普通会话样本均为 `completed`；`active/error`、软删除正数、云端 `-1` 未验证。
- **深链接**：`workbuddy-ai://chat/<id>` 对普通会话（`is_playground!=1`、未删除）单次 `open` 即稳定（单会话冷 6/6、热 3/3、最小化 1/1；双会话互跳冷 4/4、热 3/3）；失败停在首页、`open` 恒 exit 0。开关默认开启；playground 会话保守置灰（回落归因未证伪）。
- **判据**：渲染日志 `cloudProjection` 最终 pathname + ≥10s 稳定 + `[DeepLink]` 日志 + 前台 bundle id；**不要用 `resetRouterToHome`**（国际版日志从不写该标记）。
- **最终未验证**：`isMeta/isCompacted=true` 的实际形态、`status=active/error`、软删除正数时间戳、云端 `-1` 语义、三会话及以上互跳、已删除会话 id 的深链行为、playground 冷启动回落归因。

## 11. 适配器落地（as-built，2026-10-19）

> 本节记录**代码现在怎么读**，不新增事实：数据格式、深链行为与依据等级仍以 §0–§10 为准，未验证项照旧未验证。验证口径：`pnpm typecheck` 全仓通过、`pnpm --filter @tick/desktop build` 通过；真实数据只读冒烟（国内版 6 条有效会话；国际版 4 条，其中 2 条 playground `resumable=false`）与集成断言 26/26 PASS（含 4 项「未安装时静默禁用」：detect=false → list/discover 空、describe undefined）。

### 11.1 包与导出面

| 包 | 路径 | 内容 |
|---|---|---|
| `@tick/ai-workbuddy` | `packages/ai/workbuddy/src/` | 国内版适配器 + **两版共用的只读读取内核** |
| `@tick/ai-workbuddy-ai` | `packages/ai/workbuddy-ai/src/` | 国际版适配器（只声明身份，内核复用上一包） |

- `paths.ts`：App bundle 候选（`/Applications` + `~/Applications`，可注入覆盖）→ `Contents/Info.plist` 读 `CFBundleIdentifier` / `CFBundleShortVersionString`（XML 直接正则；二进制 plist 才兜底 `/usr/bin/plutil -convert json`，只读不落盘）；数据根解析（用户配置 > 该发行版的环境变量 > `~/<dir>`，不创建目录）；cwd 编码（去掉首个 `/`，其余 `/ \ :` → `-`，**空格保留**）；jsonl 定位（DB 的 cwd 直拼 → 扫 `projects/<一层>/<id>.jsonl` → `<id>.meta.json` 的 cwd 兜底 → 仍不命中返回推算路径 + `exists=false`）。
- `sqlite.ts`：`readSessionRows(rootDir, { log, id? })`。
- `transcript.ts`：`readTranscriptMeta(file)`、`extractUserText(raw)`、`collapseText`、`clipText`。
- `base-adapter.ts`：`WorkbuddyAdapterBase`（detect / listSessionInfos / discoverProjects / describeSession / launch / resume）、detect 30s 缓存、jsonl `(mtimeMs,size)` 缓存。
- `adapter.ts` / `index.ts`：`WorkbuddyAdapter` + `WORKBUDDY_IDENTITY`；`WorkbuddyAiAdapter` + `WORKBUDDY_AI_IDENTITY`。
- 装配点在 `apps/desktop/src/main/main.ts`：`new WorkbuddyAdapter({ openUrl, log })`、`new WorkbuddyAiAdapter({ openUrl, log })` → `registry.register(...)`；`openUrl` 是 main 注入的 `shell.openExternal`（`ai/*` 不依赖 Electron），日志出口只记 key + 文案，不含会话 id/标题/正文。

### 11.2 身份常量（as-built）

| 项 | 国内版 `workbuddy` | 国际版 `workbuddy-ai` |
|---|---|---|
| displayName | WorkBuddy | WorkBuddy AI |
| bundleId | `com.tencent.workbuddy.mac` | `com.workbuddy.workbuddy-ai` |
| appBundleName | `WorkBuddy.app` | `WorkBuddy AI.app` |
| scheme | `workbuddy` | `workbuddy-ai` |
| 默认数据根 | `~/.workbuddy` | `~/.workbuddy-ai` |
| 根目录环境变量 | `WORKBUDDY_CONFIG_DIR` | 无（不吃国内版的变量） |
| verifiedVersions | `['5.8.3']` | `['5.8.4']` |
| playgroundUnresumable | `false`（无实测结论，不置灰） | `true`（保守产品决定，见 §9B.6） |

两版是两个独立适配器：两个 `toolId`、两份 detect 缓存与 jsonl 缓存，互不共用配置（§1）。

### 11.3 DB 读取（只读 + WAL 兜底 + schema 探测）

- `node:sqlite` 用动态 `import` + 缓存；运行时不可用（更老的 Electron/Node）→ 返回空 + 一次日志，main 不崩。
- 主路径：`new DatabaseSync(file, { readOnly: true, enableForeignKeyConstraints: false })` 直接读 live 库；**构造成功后立刻 `SELECT count(*) FROM sqlite_master` 试读一次**——WAL 库缺 `-shm` / 目录不可写时会构造成功、首次访问才报 `unable to open database file`，所以不能把「构造成功」当可用。
- 兜底：试读失败才 `mkdtemp('tick-wb-')` → 复制 `workbuddy.db` + 存在的 `-wal` / `-shm` → 以**普通方式**打开副本（会回放 `-wal`）→ `finally` 关闭并删临时目录。**禁用 `immutable=1`**（忽略 `-wal`，§10.8 实测读到 0 行）。
- schema 探测：`PRAGMA table_info(sessions)` 检查必需列 `id / cwd / status / created_at / updated_at / deleted_at / transport`，缺列即判「schema 不识别」→ 整体返回空（不读出半套错误数据）；`title / custom_title / last_activity_at / is_playground / is_background_automation` 等可选列缺失时用 `NULL` / `0` 常量兜底。
- 过滤与排序：`COALESCE(deleted_at, -1) <= 0`、`COALESCE(transport, 'local') = 'local'`、`COALESCE(is_background_automation, 0) != 1`，按 `COALESCE(last_activity_at, updated_at) DESC`；单条查询（`id = ?`）用于 `resume` / `describeSession`。
- 任何异常 → `[]` + 一次日志，绝不向 UI 抛（§7 失败降级）。

### 11.4 合同映射

- `detect()`：只看 App bundle + `Info.plist` 的 `CFBundleIdentifier`（**数据目录存在不算已安装**）；`CFBundleShortVersionString` 超出 `verifiedVersions` → `installed: true` + 「版本未验证」；detect 结果缓存 30s（IPC 会反复问）。
- 未安装 = 静默禁用（PRD §9.9 / §9B.7）：`detect()` 不通过时 `listSessionInfos()` / `discoverProjects()` 直接返回 `[]`、`describeSession()` 返回 `undefined`——卸载残留的数据目录（`~/.workbuddy*`）不会被当成「这个工具还在用」，也不会出现在「倒入历史会话」/项目索引里。
- `listSessionInfos()`：**只读 DB 一条查询，不扫 jsonl**；`cwd` 用 `resolveTranscript` 的兜底值，`createdAt` 取 `created_at`（缺失回退 `updated_at`），`lastUsedAt` 取 `last_activity_at`（缺失回退 `updated_at`），`filePath` / `exists` / `size` 来自 `stat` 事实，按 `lastUsedAt` 降序。
- `discoverProjects()`：只吐原始证据（`path` / `sessionCount` / `lastUsedAt` / `exists`）；非绝对路径的 cwd 先经 `<id>.meta.json` 兜底，仍不绝对就跳过。**不做** canonical 归一、git 根上卷、跨工具合并（归并是 `ai/core` 的 `mergeProjects`）。
- `describeSession(id, { withName })`：先按 id 查 DB（不存在/已软删除 → `undefined`）；`withName: false` 只回 DB 元数据；否则才读 jsonl 取 `firstMessage` / `lastMessage` / 标题兜底，并按文件 `(mtimeMs, size)` 缓存（上限 500 条，超限直接清空）。
- `launch()`：直接抛 `launchErrorText`（桌面应用不能从 Tick 新建会话）。
- `resume(id, ctx)`：`detect()` → DB 校验 id 存在且未删除（国际版再加 playground 拒绝）→ `openUrl('<scheme>://chat/<encodeURIComponent(id)>')` → 返回 `delivered: 'none'`、`verified: true`。单次调用，不重试。
- `capabilities`：`newSessionMode='prefill'`（`openNewSessionPage()` 打开 GUI 新建页并预填；不自动发送/不绑定）、`resumeSession=true`、`deliverPrompt=[]`、`needsCwd=false`、`setSessionName=false`、`discoverProjects=true`、`describeSessions=true`、`usage=false`。

### 11.5 消息流解析与合成消息过滤

- 流式按行扫描，只解析含 `"message"` / `"ai-title"` / `"custom-title"` 的行；末行半行与坏行忽略，未知 `type` 一律忽略；不缓存正文，只留首/末 user 文本与标题兜底。
- 真实 user 请求：`role=user` 且 `providerData.isMeta !== true` 且 `providerData.isCompacted !== true`；优先 `startsNewUserRequest === true`；该字段缺失（国内版样本 6/73 条 user 消息没有它）时回退为「文本含 `<user_query` 开标签」。
- 原文抽取：优先 `<user_query …>…</user_query>`（非贪婪 + DOTALL，**标签可以带属性**）；没有该标签时剥离 `<system-reminder …>…</system-reminder>` 取剩余；随后空白折叠。
- 长度：`name` / `firstMessage` 折叠后截 160 字符（超出加 `…`），`lastMessage` 上限 2000 字符（只防 IPC 载荷失控，不是展示阈值）；DB 与 jsonl 时间戳均按**毫秒**处理，缺失时用 `updated_at` 兜底、仍缺失取 epoch（信号是「未知」而不是「现在」）。
- 标题：DB `custom_title` > `title`；都没有时用 jsonl 的 `custom-title` > `ai-title`。
- `resumable`：缺省 = 可回到；国际版 `is_playground=1` → `false`，`resume()` 直接拒绝；国内版无该结论，不置灰（§9B.6 只对国际版成立）。

### 11.6 深链接与调用前校验

- URL：`workbuddy://chat/<id>`、`workbuddy-ai://chat/<id>`（id 经 `encodeURIComponent`）。
- **调用前一定先查 DB**：按 id 查询有效行，查不到（不存在 / 已软删除 / 非 local / 后台自动化）直接抛错，不调用深链——不存在 id 的深链会落首页或空会话页且 `open` 恒 exit 0（§8.2、§10.5）。
- 国际版对 `is_playground=1` 额外拒绝（保守决定，不是已证事实）。
- `open` 恒 exit 0，失败=停在首页：单次、不重试、不阻塞、**不降级到另一个 scheme**（调 `workbuddy://` 会拉起另一个工具）；`openUrl` 未注入时直接抛错。

### 11.7 仍未验证（不因落地而升级）

沿用 §0.3 / §10.11：`isMeta/isCompacted=true` 的实际形态、`status=active/error`、软删除正数时间戳、云端 `-1` 语义、三会话及以上深链互跳、已删除会话 id 的深链行为、playground 冷启动回落归因。本节只说明实现方式，**依据等级与本表未验证项均不因适配器落地而上调**。

### 11.8 打开新建任务页（newSessionMode='prefill'，2026-10-19）

- **入口**：`openNewSessionPage(ctx)` → `openUrl('<scheme>://task?action=start&prompt=<encoded>&cwd=<encoded>')`。scheme 用各自身份的 `workbuddy` / `workbuddy-ai`；`cwd` 是 Tick 侧的本地项目路径（绝对路径）。
- **App 行为**（从 5.8.3/5.8.4 renderer 代码 + 本机实测）：主进程把 `task` URL 分发给 renderer → `TaskDeeplinkCoordinator` 消费 → `goHome` + `input-draft-intent prepare-input`，把 prompt 预填进新建任务页输入框、把 `cwd` 设为工作空间；**不自动发送、不创建会话**（实测调用前后 DB 会话数不变），发送仍由用户点击完成，之后走「倒入历史会话」绑定。
- **参数范围**：`action` 必填且只接受 `start`；`prompt` App 侧上限 8000 字符；`cwd` 可选（本实现必传）；`promptContentBlocks` / `payloadId` / `welcomeMode` / `mode` / `permissionMode` / `model` / `expertId` / `skills` / `connectorIds` / `source` / `corpId` 为可选内部参数，Tick 只使用 `action/prompt/cwd`。
- **安全长度**：整条 URL 超过 ~6000 时部分平台（Windows 命令行）可能唤不起来；本实现在编码后的 URL 长度 > 6000 时截断 prompt（末尾加 `…`）并返回 `truncated=true`，不假装原文已完整预填。
- **身份与权限**：不读 WorkBuddy 的任何配置/凭据；`openUrl` 由 main 注入 `shell.openExternal`；App 未安装 / 非绝对 cwd / 空文案均返回可读 reason，不调用深链。
- **未公开规范**：该协议不是官方文档契约，版本升级可能变化；已在 5.8.4 实测（国际版），5.8.3（国内版）代码路径相同但客户端当前启动异常，待其恢复后复测。不要把它当稳定 API 对外承诺。
- **门控（2026-10-19 补）**：`WorkbuddyIdentity.taskVerifiedVersions` 是唯一开关；国内版 `['5.8.3']`、国际版 `['5.8.4']` 均为 `prefill`；未命中的版本 `newSessionAvailable=false`（UI 仍列出该已安装工具，但禁用并显示 reason），直接调 `openNewSessionPage` 也返回「未验证，暂不支持」。升级版本后必须重新真机验证再放行。
- **回执/失败**：该深链接没有 App 侧回执；`openUrl` resolve 只代表交给 LaunchServices，不代表 App 真的打开新建页。Tick 的成功文案只写「已打开/已发出」，不承诺一定预填成功。
- **数据边界**：prompt 与 cwd 会作为 query 进入自定义 scheme URL，可能被 LaunchServices/目标 App 日志记录；Tick 自己不把 URL 写日志。若正文敏感，用户应只预填标题或先在 App 内输入。

### 11.9 只读证据（2026-10-19）

把 `workbuddy.db` + `-wal` + `-shm` 复制到临时目录后，用两个适配器各跑 `listSessionInfos` / `discoverProjects` / `describeSession`，再做 sha256 + mtime 对比（排除真实 App 并发写入的干扰）：

- `workbuddy.db`：hash/size/mtime 前后完全一致；
- `workbuddy.db-wal`：hash/size/mtime 前后完全一致；
- `workbuddy.db-shm`：hash 改变、mtime 前进（SQLite 只读打开 WAL 时维护读标记）。

结论：Tick 不写 db/-wal/会话数据；`-shm` 的改动来自 SQLite WAL 读语义，不是 Tick 写正文。若要求字节级零写入，必须始终走复制路径（代价是每次读取多拷一份 DB）。
