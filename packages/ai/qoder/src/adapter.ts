/**
 * @tick/ai-qoder — Qoder CLI 适配器（两个发行版：`qoder` / `qoder-cn`）。
 *
 * 为什么这么薄：Qoder CLI 的会话**逐字段复用 Claude Code 的格式**——
 * `projects/<编码 cwd>/<id>.jsonl`，行是 `user`/`assistant`（Anthropic usage，只写在一条回复的最后一块上）、
 * `ai-title`/`summary`，每条带 `cwd` 与 `sessionId`，子代理在 `<id>/subagents/agent-<id>.jsonl`。
 * 依据：magpie（yetone/magpie）的 `internal/sessions/qoder.go`——
 * 「the lines Claude Code's … They are read as Claude Code's are」。
 *
 * 所以本包只声明身份（与 `@tick/ai-workbuddy` / `@tick/ai-workbuddy-ai` 同一套「内核共用、身份独立」做法）：
 *  - 数据根：`$QODER_CONFIG_DIR` > `~/.qoder`（国内版 `$QODERCN_CONFIG_DIR` > `~/.qoder-cn`）；
 *  - 可执行：`qodercli` / `qoderclicn`；
 *  - resume：`qodercli --resume <id>`（magpie 的 resumeCommand；**只认 id，不接受 transcript 路径**）；
 *  - 新建：**没有** `--session-id` 类能力 → `newSessionMode='prefill'` +
 *    `prefillDelivery='terminal-copy'`（打开终端里的 Qoder + 文案进剪贴板，不自动发送/不绑定）。
 *
 * 两个发行版仍是**两个独立工具**（两个 toolId、两份缓存、各自的数据根与 env），
 * 不通过切换根目录复用同一个实例（rules §1）。
 *
 * 未验证项（本机未安装 Qoder，只有第三方实现的格式证据）：
 *  - `qodercli --resume <id>` 在会话文件位于其它项目目录时是否仍能命中（magpie 的 resume 会先 cd cwd）；
 *  - 是否有 `--name` / `--prefill`；
 *  - 子代理文件与 `custom-title` 的实际写入形态。
 * 这些都不影响降级：读不到返回空，resume 失败由终端如实暴露。
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { AiToolAdapter, CarryCapability, NewSessionPageContext, NewSessionPageResult } from '@tick/ai-core'
import { openTerminalCopyWithClipboard } from '@tick/ai-core'
import { toolDisplayName } from '@tick/shared'
import {
  ClaudeAdapter,
  type ClaudeSessionRoot,
  type ClaudeToolIdentity,
} from '@tick/ai-claude'
import { findCliExecutable, type TerminalOpenSpec } from '@tick/ai-pi'

/** 一个 Qoder 发行版的固定身份 */
export interface QoderDistro {
  toolId: 'qoder' | 'qoder-cn'
  /** 可执行名（`qodercli` / `qoderclicn`） */
  exeName: string
  /** 数据根环境变量 **名称**（不是值；两个发行版各吃各的） */
  envRootVar: 'QODER_CONFIG_DIR' | 'QODERCN_CONFIG_DIR'
  /** 默认数据根目录名 */
  defaultRootName: string
}

export const QODER_DISTRO: QoderDistro = {
  toolId: 'qoder',
  exeName: 'qodercli',
  envRootVar: 'QODER_CONFIG_DIR',
  defaultRootName: '.qoder',
}

export const QODER_CN_DISTRO: QoderDistro = {
  toolId: 'qoder-cn',
  exeName: 'qoderclicn',
  envRootVar: 'QODERCN_CONFIG_DIR',
  defaultRootName: '.qoder-cn',
}

/**
 * 数据根：环境变量 > 默认目录（与 `CLAUDE_CONFIG_DIR > ~/.claude` 同一套语义）。
 * 只读：不创建目录，不存在时后续读取自然降级为空。
 */
export function resolveQoderRoot(
  distro: QoderDistro,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  const override = env[distro.envRootVar]?.trim()
  return override ? path.resolve(override) : path.join(home, distro.defaultRootName)
}

/** `<root>/projects`；目录不存在返回空数组（不 mkdir） */
export function resolveQoderSessionRoots(
  distro: QoderDistro,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): ClaudeSessionRoot[] {
  const dir = path.join(resolveQoderRoot(distro, env, home), 'projects')
  if (!existsSync(dir)) return []
  return [{ dir, source: env[distro.envRootVar]?.trim() ? 'env' : 'default' }]
}

export interface QoderAdapterDeps {
  /** 剪贴板投递出口（main 注入 clipboard.writeText） */
  clipboardWrite?: (text: string) => void
  /** 可执行文件定位（默认 findCliExecutable(exeName)） */
  resolveExe?: () => Promise<string | null>
  /** 在终端里打开（main 注入 .command + open 实现） */
  openTerminal?: (spec: TerminalOpenSpec) => Promise<void> | void
  /** 会话根覆盖（产品运行时由 env / 默认目录解析；测试隔离用） */
  sessionRoots?: () => ClaudeSessionRoot[]
}

/** Qoder 适配器 = Claude 格式复用内核 + 该发行版的身份 */
export class QoderAdapter implements AiToolAdapter {
  readonly id: string
  readonly capabilities: AiToolAdapter['capabilities']
  readonly carry: CarryCapability

  private inner: ClaudeAdapter
  private distro: QoderDistro
  private deps: QoderAdapterDeps

  constructor(distro: QoderDistro, deps: QoderAdapterDeps = {}) {
    this.distro = distro
    this.deps = deps
    this.id = distro.toolId
    const identity: ClaudeToolIdentity = {
      toolId: distro.toolId,
      exeName: distro.exeName,
      // magpie 的 resumeCommand：`qodercli --resume <id>`（先 cd 到会话 cwd）。这里只给 argv，
      // cwd 由共用内核按会话自己的 cwd 决定（与 Claude 的 resume 同一纪律：不信任 Tick 侧项目）。
      resumeArgs: (sessionId) => ['--resume', sessionId],
      // 没有「预生成 id」的能力；CLI 也没有草稿 API → 走 prefill/terminal-copy
      newSessionMode: 'prefill',
      // 未见 `--name` 证据：不假装支持
      setSessionName: false,
      // 未见 `--prefill=` 证据：只保留「直接发送」与剪贴板（launch 本身不可用，投递方式仅为合同完整性）
      deliverPrompt: ['argv', 'clipboard'],
    }
    this.inner = new ClaudeAdapter({
      identity,
      ...(deps.clipboardWrite ? { clipboardWrite: deps.clipboardWrite } : {}),
      ...(deps.resolveExe ? { resolveExe: deps.resolveExe } : {}),
      ...(deps.openTerminal ? { openTerminal: deps.openTerminal } : {}),
      sessionRoots: () => deps.sessionRoots?.() ?? resolveQoderSessionRoots(distro),
    })
    // 共享内核（ClaudeAdapter）不知道这个投递形态，由本适配器补上
    this.capabilities = { ...this.inner.capabilities, prefillDelivery: 'terminal-copy' }
    this.carry = {
      acceptFrom: [],
      exposes: [{ format: distro.toolId }],
    }
  }

  get displayName(): string {
    return toolDisplayName(this.distro.toolId)
  }

  detect(): ReturnType<AiToolAdapter['detect']> {
    return this.inner.detect()
  }
  discoverProjects(): ReturnType<NonNullable<AiToolAdapter['discoverProjects']>> {
    return this.inner.discoverProjects()
  }
  listSessions(cwd?: string): ReturnType<NonNullable<AiToolAdapter['listSessions']>> {
    return this.inner.listSessions(cwd)
  }
  listSessionInfos(): ReturnType<NonNullable<AiToolAdapter['listSessionInfos']>> {
    return this.inner.listSessionInfos()
  }
  describeSession(
    id: Parameters<NonNullable<AiToolAdapter['describeSession']>>[0],
    opts?: Parameters<NonNullable<AiToolAdapter['describeSession']>>[1],
  ): ReturnType<NonNullable<AiToolAdapter['describeSession']>> {
    return this.inner.describeSession(id, opts)
  }
  computeUsage(
    id: Parameters<NonNullable<AiToolAdapter['computeUsage']>>[0],
  ): ReturnType<NonNullable<AiToolAdapter['computeUsage']>> {
    return this.inner.computeUsage(id)
  }
  verify(
    id: Parameters<NonNullable<AiToolAdapter['verify']>>[0],
    opts?: Parameters<NonNullable<AiToolAdapter['verify']>>[1],
  ): ReturnType<NonNullable<AiToolAdapter['verify']>> {
    return this.inner.verify(id, opts)
  }
  /**
   * CLI 没有草稿 API（`qodercli --prompt` 会立刻发送）——走共享的 terminal-copy 实现：
   * 打开终端里的 Qoder，文案放进剪贴板，由用户 ⌘V + 回车确认；不预生成 id、不绑定。
   *
   * 可执行文件解析**必须复用注入的 `resolveExe`**（与 detect 同一套）：否则测试/诊断注入的
   * 路径在这条分支失效，真实环境又悄悄退回系统探测。
   */
  async openNewSessionPage(ctx: NewSessionPageContext): Promise<NewSessionPageResult> {
    return openTerminalCopyWithClipboard(ctx, {
      displayName: this.displayName,
      detect: () => this.inner.detect(),
      requireExe: async () => {
        const exe = this.deps.resolveExe ? await this.deps.resolveExe() : await findCliExecutable(this.distro.exeName)
        if (!exe) throw new Error(`${this.distro.exeName} 不在 PATH`)
        return exe
      },
      ...(this.deps.openTerminal ? { openTerminal: this.deps.openTerminal } : {}),
      ...(this.deps.clipboardWrite ? { clipboardWrite: this.deps.clipboardWrite } : {}),
    })
  }

  launch(ctx: Parameters<AiToolAdapter['launch']>[0]): ReturnType<AiToolAdapter['launch']> {
    return this.inner.launch(ctx)
  }
  resume(
    id: Parameters<AiToolAdapter['resume']>[0],
    ctx: Parameters<AiToolAdapter['resume']>[1],
  ): ReturnType<AiToolAdapter['resume']> {
    return this.inner.resume(id, ctx)
  }
}
