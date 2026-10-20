/**
 * ZCodeAdapter — ZCode（OpenCode 的桌面发行版）适配器，toolId = `zcode`。
 *
 * 与 OpenCode 的关系（rules §1：同一内核、独立身份）：
 *  - 表结构相同（`session`/`message`/`part`），但 **`session` 行没有 token/cost 列** →
 *    用量取它的 `model_usage` 表（每次模型调用一行，含重试）；
 *  - **桌面应用**：没有任何 resume 通道 → `capabilities.resumeSession=false`，
 *    `resume()` 直接抛错（只能「看」与「记」，不能跳转）；
 *  - 数据库在 `~/.zcode/cli/db/db.sqlite`（magpie `ZCodeDir`）；
 *  - **装没装只看 App bundle**（`dev.zcode.app` / `ZCode.app`），数据目录存在不算已安装（rules §4）；
 *    有数据但没 App 是卸载残留，`detect().reason` 会区分开。
 */

import { toolDisplayName } from '@tick/shared'
import { OpenCodeAdapter, resolveZCodeDbPath, type OpenCodeAdapterDeps, type OpenCodeIdentity } from '@tick/ai-opencode'

export function zcodeIdentity(): OpenCodeIdentity {
  return {
    toolId: 'zcode',
    displayName: toolDisplayName('zcode'),
    dbPath: resolveZCodeDbPath(),
    usageSource: 'model-usage',
    // 没有 CLI，也没有深链接：不回会话
    desktopBundleId: 'dev.zcode.app',
    desktopBundleName: 'ZCode.app',
  }
}

export class ZCodeAdapter extends OpenCodeAdapter {
  constructor(deps: OpenCodeAdapterDeps = {}) {
    super(zcodeIdentity(), deps)
  }
}
