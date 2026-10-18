# WorkBuddy 适配调研笔记（只读调研，2026-10-18）

> 全程只读：DB 复制到 /tmp 后用 `sqlite3 -readonly` 读取；未读取任何密钥/token；未对 WorkBuddy 数据做任何写操作；未执行 open/深链接实验。文中不含真实对话内容。

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
- 前置状态：前台 Google Chrome；WorkBuddy 主进程 `Electron`（`/Applications/WorkBuddy.app/Contents/MacOS/Electron`，bundle id **com.github.Electron**，不是 com.tencent.workbuddy.mac）已运行，窗口 1 个。`pgrep -fl WorkBuddy` 能匹配到完整路径含 WorkBuddy.app 的进程。
- 测试1（先激活 Finder，再 open A，等 4s）：前台变为 Electron(com.github.Electron)；截图确认 WorkBuddy 窗口在最前，顶部会话标题=“示例会话 A”，与 A 一致。
- 测试2（先激活 Finder，再 open B）：同样前置；窗口标题=“示例会话 B”，侧栏高亮 B，与 B 一致。
- 测试3（AXMinimized=true 最小化后 open A）：最小化后前台仍是 Electron；open 后窗口 AXMinimized 变 false、窗口恢复并前置，标题回到“示例会话 A”。
- 注意：System Events 窗口名恒为 “WorkBuddy”，会话标题是应用内标题栏，不在 AX 窗口名中，验证需截图。判断前台应用应用 bundle id com.github.Electron。
- 测后已激活 Google Chrome 恢复前台。截图含个人内容，勿外传。

## 9. 国际版 WorkBuddy AI（workbuddy.ai）——独立工具（初次只读观察；本期实测见 §10）
> 定位：与国内版 WorkBuddy 是**两个独立工具**。（原“后续”已升为本期 P0 独立适配器，见 §10。）以下仅为本机只读观察与官网文档核对（2026-10-18），**其 scheme / 目录 / 数据格式均未经充分验证，不得套用 §2–§8 的国内版结论**。未修改任何应用配置，未读取会话/密钥内容，未执行 open / 深链接。

### 9.1 本机只读观察（仅本机观察，未验证）
| 项 | 观察值 | 等级 |
|---|---|---|
| 应用 | /Applications/WorkBuddy AI.app，CFBundleName/DisplayName = `WorkBuddy AI` | 仅本机观察 |
| Bundle ID | `com.workbuddy.workbuddy-ai`（Info.plist） | 仅本机观察 |
| 版本 | 5.8.4（Info.plist；与 workbuddy.ai 官方 Changelog 的 5.8.4 条目版本号一致） | 仅本机观察 + 官网佐证版本号 |
| URL scheme | `workbuddy-ai`（Info.plist 的 CFBundleURLTypes，URLName=`WorkBuddy AI Deep Links`）；路径/参数未验证 | 仅本机观察；**未验证** |
| 数据目录 | ~/.workbuddy-ai 存在；含 workbuddy.db、.workbuddy-sqlite-migrations 等（仅查看文件名），sessions/ 为空，**无 projects/**；表结构、jsonl 格式**未检查** | 仅本机观察；**未验证** |
| 根目录环境变量 | 无任何依据 | **未验证** |

### 9.2 官网文档核对（workbuddy.ai）
- 官网 https://www.workbuddy.ai/ 为国际版页面（页面内含 `IS_INTERNATIONAL_EDITION = 'true'` 标记）；文档站 https://www.workbuddy.ai/docs/workbuddy/ （Quickstart、Changelog 等）。
- Quickstart：产品名 Tencent WorkBuddy，桌面端 AI agent；登录使用 Google / GitHub OAuth（国内版文档为另一套账号体系，不可互套）。
- Changelog：含 5.8.4、5.7.6、5.6.2 等条目；**未见 deeplink、会话存储格式、hooks 的任何说明**。
- Tencent Cloud International 的 WorkBuddy 产品/文档页（intl.cloud.tencent.com）为企业版文档，与桌面端本地存储无关。
- 结论：国际版**没有**公开的 scheme、数据目录、数据格式规范；其 deeplink、会话存储是否与国内版一致**未验证**。
- 独立适配器前置项（本期实测见 §10，仍未完成部分）：独立验证 scheme 与路径、`workbuddy.db`/jsonl 格式、完成状态字段、前台进程名；单独建立依据表。

## 10. 国际版 WorkBuddy AI 本期实测（2026-10-18 17:36–17:50 UTC+8，5.8.4）——独立适配器 `workbuddy-ai`

> 不得与 §2–§8（国内版）混用。全程只读：db 复制到临时目录后以 `mode=ro` 打开；未读取会话标题/内容/ID，也未读 keyblob/settings。文档不含任何会话标题/ID/截图路径。

### 10.1 实测环境
- 应用：`/Applications/WorkBuddy AI.app`，bundle `com.workbuddy.workbuddy-ai`，5.8.4，可执行名 `Electron`；Info.plist `CFBundleURLSchemes = workbuddy-ai`（URLName `WorkBuddy AI Deep Links`）。
- 主进程测试时**未运行**；Mac **屏幕锁定**（IOConsoleLocked=Yes，HID 空闲约 56 分钟）；前台 Google Chrome。

### 10.2 数据库（只读）
- `~/.workbuddy-ai/workbuddy.db`：单文件（无 -wal/-shm），表：`sessions`、`workspaces`、`automations`、`automation_runs`、`automation_runtime_state`、`automation_delivery_outbox`、`migration_meta`、`session_usage`、`buddy_snapshots`、`workspace_trust_decisions`、`__workbuddy_drizzle_migrations`（**无** `cloud_conversations` 表，已在迁移 0012 合并进 `sessions`）。
- `sessions` 共 40 列：id、cwd、user_id、title、custom_title、status、created_at、updated_at、last_activity_at、deleted_at、is_playground、source_mode、is_background_automation、mode、model、expert_*、permission_mode、use_sandbox_cli、project_id、plugin_context_json、addon_selection、session_settings、last_user_prompt_expert_selection、context_window、buddy_*、thought_level、transport、conversation_origin、visibility、group_id、group_title、agent_dirty*、verified_at、unread。
- **会话数量：0**（`sessions` 0 行、`session_usage` 0、`workspaces` 0）。迁移脚本最新 0017；`status` 默认 `Pending`，`deleted_at` 可空，`transport` 默认 `local`，`unread` 默认 0。
- 注意：本机 `sqlite3` CLI 对 `.tables` 与 `-readonly` 打开在此环境报 “unable to open database file”，改用 Python `sqlite3` 的 `file:…?mode=ro` URI 读取正常（环境问题，适配器应以库 API 读取并处理打开失败）。

### 10.3 会话记录位置
- `~/.workbuddy-ai/projects/`：**不存在**；全盘 `~/.workbuddy-ai` 下 `*.jsonl` 0 个；`sessions/` 目录为空（无进程心跳）。
- 结论：**消息流位置与格式无法在本机验证**。

### 10.4 与国内版逐项对照
| 项 | 结果 |
|---|---|
| sessions 表存在及核心列（id/cwd/title/custom_title/status/时间戳/deleted_at/transport/is_background_automation/unread） | **一致**（已实测） |
| 迁移机制 `.workbuddy-sqlite-migrations`、drizzle 迁移表 | 一致（国际版最新 0017，国内版另有差异未逐项比对） |
| 表集合 | 国际版无独立 `cloud_conversations` 表（合并入 sessions）；国内版未做逐表对照，**不下结论** |
| role=user、`user_query` 包装、`isMeta`/`isCompacted`/`startsNewUserRequest` | **未验证**（无 jsonl） |
| status 完成判定（completed/active/error） | **未验证**（0 行；仅确认默认 `Pending`） |
| deleted_at 语义 | **未验证**（列存在、可空；迁移脚本显示云端行用 -1 表示未删除） |
| 主进程名 | 可执行名 `Electron`，与国内版同；前台 bundle id 未测 |

### 10.5 深链接
- **未执行 `open`**：按要求“测试前确认屏幕未锁”，当前锁屏且应用未运行，执行会冷启动应用且无法目视/截图验证，故跳过 `workbuddy-ai://home`、`workbuddy-ai://chat/<id>`、不存在 id 三项。本机亦无已存在会话可测。
- 静态证据（app.asar 字符串，未执行）：含 `[DeepLink] dispatching open url to renderer`、`handleOpenUrl ignored non-workbuddy url` 等与国内版同构的处理；字面量有 `workbuddy://chat/`、`workbuddy://home`、`workbuddy://automation/run?`、`workbuddy://agentmail`，**未检索到 `workbuddy-ai://` 字面量**；URL 校验函数是否放行 `workbuddy-ai://` **不明**。→ 深链接行为**未验证**，且存在“scheme 被忽略”的风险。
- 另：app 内以 `WORKBUDDY_CONFIG_DIR` 含 `workbuddy-ai` 判断 overseas/cn（仅逆向字符串）。

### 10.6 官网文档（workbuddy.ai，只读）
- Changelog（https://www.workbuddy.ai/docs/workbuddy/Changelog ）：5.8.4、5.7.6、5.6.2、5.5.0、5.2.7、5.2.3；**无** deeplink/scheme、本地存储格式、hooks 的说明；仅 5.8.4 提到“Scheduled task status, recovery, notifications, and result navigation”、“Large or malformed history records preventing conversations from opening”（说明历史记录格式会变/有损坏情形）。
- Quickstart：登录用 Google/GitHub OAuth（见 §9.2）。官方无存储/深链/hooks 规范。

### 10.7 仍未验证
会话 jsonl 格式与全部消息规则；status 取值与 deleted_at 语义；三种深链接及冷/热启动、不存在 id、前台 bundle id；hooks；根目录环境变量实际行为。需在有国际版会话、屏幕解锁时补测，补测前适配器“回到会话”默认关闭（PRD §9B.6）。
