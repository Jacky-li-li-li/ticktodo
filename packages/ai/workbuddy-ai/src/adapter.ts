/**
 * WorkbuddyAiAdapter — 国际版 WorkBuddy AI（workbuddy.ai）适配器，toolId = `workbuddy-ai`。
 *
 * 身份（PRD §9B.1、notes §0.1 / §10.11，全部本机实测）：
 *   App `/Applications/WorkBuddy AI.app`（bundle `com.workbuddy.workbuddy-ai`，已验证 5.8.4）
 *   数据根 `~/.workbuddy-ai`（目录名来自 App 内 `cli/product.json` 的 dataFolderName；
 *   **不吃国内版的 `WORKBUDDY_CONFIG_DIR`**）
 *   scheme `workbuddy-ai`（`workbuddy-ai://chat/<id>`：普通会话冷/热/最小化与双会话互跳均稳定）
 *
 * 与国内版的关系（rules §1）：**独立工具、独立适配器**，只复用同一套存储读取内核；
 * 不通过环境变量/根目录切换复用国内版配置，任何一侧未安装都不影响另一侧。
 *
 * playground 策略（PRD §9B.6 保守产品决定，不是已证事实）：`is_playground=1` 的会话
 * 深链接冷启动回落原因未证伪 → `resumable=false`，resume 直接拒绝。
 */

import type { AiToolAdapter } from '@tick/ai-core'
import { toolDisplayName } from '@tick/shared'
import {
  WorkbuddyAdapterBase,
  type WorkbuddyAdapterDeps,
  type WorkbuddyIdentity,
} from '@tick/ai-workbuddy'

export const WORKBUDDY_AI_IDENTITY: WorkbuddyIdentity = {
  toolId: 'workbuddy-ai',
  // 展示名单一来源：shared 的 TOOL_DISPLAY_NAMES，避免和 tools:status/toast 漂移
  displayName: toolDisplayName('workbuddy-ai'),
  bundleId: 'com.workbuddy.workbuddy-ai',
  appBundleName: 'WorkBuddy AI.app',
  scheme: 'workbuddy-ai',
  defaultRootName: '.workbuddy-ai',
  // 国际版没有根目录环境变量覆盖：两个 build 以各自 App bundle + 数据根区分
  verifiedVersions: ['5.8.4'],
  // 仅 5.8.4 实测过 task 新建页（goHome + prefill，不发送）；升级后需重新验证
  taskVerifiedVersions: ['5.8.4'],
  // playground 深链接冷启动回落归因未证伪 → 保守置灰
  playgroundUnresumable: true,
  launchErrorText:
    'WorkBuddy AI 是桌面应用，不能从 Tick 新建会话；请先在 WorkBuddy AI 里开始，再用「倒入历史会话」绑定。',
}

export class WorkbuddyAiAdapter extends WorkbuddyAdapterBase implements AiToolAdapter {
  constructor(deps: WorkbuddyAdapterDeps = {}) {
    super(WORKBUDDY_AI_IDENTITY, deps)
  }
}
