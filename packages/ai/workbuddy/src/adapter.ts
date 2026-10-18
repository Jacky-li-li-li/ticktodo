/**
 * WorkbuddyAdapter — 国内版 WorkBuddy（workbuddy.cn）适配器，toolId = `workbuddy`。
 *
 * 身份（PRD §9.8、notes §0.1，全部本机实测）：
 *   App `/Applications/WorkBuddy.app`（bundle `com.tencent.workbuddy.mac`，已验证 5.8.3）
 *   数据根 `~/.workbuddy`（第三方实现记载 `WORKBUDDY_CONFIG_DIR` 可覆盖，本机未验证生效）
 *   scheme `workbuddy`（`workbuddy://chat/<id>`，冷/热/最小化实测均能定位）
 *
 * 国际版 WorkBuddy AI 是**另一个独立工具**，见 `@tick/ai-workbuddy-ai`；两者不共用配置、
 * 不共用 toolId、不通过切换根目录复用本类（rules §1）。
 */

import type { AiToolAdapter } from '@tick/ai-core'
import { toolDisplayName } from '@tick/shared'
import { WorkbuddyAdapterBase } from './base-adapter'
import type { WorkbuddyAdapterDeps, WorkbuddyIdentity } from './types'

export const WORKBUDDY_IDENTITY: WorkbuddyIdentity = {
  toolId: 'workbuddy',
  // 展示名单一来源：shared 的 TOOL_DISPLAY_NAMES，避免和 tools:status/toast 漂移
  displayName: toolDisplayName('workbuddy'),
  bundleId: 'com.tencent.workbuddy.mac',
  appBundleName: 'WorkBuddy.app',
  scheme: 'workbuddy',
  defaultRootName: '.workbuddy',
  // 只作用于国内版的根目录覆盖；国际版不吃这个变量（不靠它判断版本）
  envRootVar: 'WORKBUDDY_CONFIG_DIR',
  verifiedVersions: ['5.8.3'],
  // 2026-10-19 真机复测：5.8.3 的 task 深链接会 goHome + 预填输入框，不发送/不建会话
  taskVerifiedVersions: ['5.8.3'],
  // 国内版 playground 的深链接行为没有实测结论，不因此置灰
  playgroundUnresumable: false,
  launchErrorText:
    'WorkBuddy 是桌面应用，不能从 Tick 新建会话；请先在 WorkBuddy 里开始，再用「倒入历史会话」绑定。',
}

export class WorkbuddyAdapter extends WorkbuddyAdapterBase implements AiToolAdapter {
  constructor(deps: WorkbuddyAdapterDeps = {}) {
    super(WORKBUDDY_IDENTITY, deps)
  }
}
