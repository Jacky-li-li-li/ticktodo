/**
 * SettingsStore — `~/.ticktodo/data/settings.json`（PRD F4-b 的两个开关 + F6-b 用量开关）。
 *
 * 数据层语义：settings 是「用户意图」，属于 data/（可同步）层；文件 0600，原子写。
 * 只做白名单字段合并，避免 renderer/旧版本写入未知字段把文件搞坏。
 */

import fs from 'node:fs'
import type {
  AppSettings,
  CustomProviderConfig,
  DefaultProjectSetting,
  LaunchDeliverSetting,
  ToolClientId,
} from '@tick/shared'
import { DEFAULT_SETTINGS } from '@tick/shared'
import { atomicWriteJson, readJson } from './storage'

interface SettingsFile {
  version: 1
  settings: AppSettings
}

/** 设置里只暴露 prefill / argv；clipboard 仅作为旧配置/运行期降级，不再写入 settings */
const DELIVERS: LaunchDeliverSetting[] = ['prefill', 'argv']
const DEFAULT_PROJECTS: DefaultProjectSetting[] = ['home', 'recent', 'ask']

/**
 * 多客户端偏好（toolId → desktop/cli）的白名单归一化：
 * 只接受已知值，未知 toolId 也先留着（适配器可能来自更新版本），但不接受非法客户端名。
 */
function normalizeToolClients(raw: unknown): Record<string, ToolClientId> | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const out: Record<string, ToolClientId> = {}
  for (const [toolId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === 'desktop' || value === 'cli') out[toolId] = value
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** 自配 provider 的白名单归一化：只接受合法形状，旧版本/未知字段不进文件 */
function normalizeProvider(raw: CustomProviderConfig | null | undefined): CustomProviderConfig | null {
  if (!raw) return null
  if (typeof raw.baseUrl !== 'string' || !raw.baseUrl.trim()) return null
  if (typeof raw.model !== 'string' || !raw.model.trim()) return null
  const config: CustomProviderConfig = {
    baseUrl: raw.baseUrl.trim(),
    model: raw.model.trim(),
    keyStored: raw.keyStored === true,
  }
  if (typeof raw.name === 'string' && raw.name.trim()) config.name = raw.name.trim()
  if (raw.lastTest && typeof raw.lastTest === 'object') {
    config.lastTest = {
      ok: raw.lastTest.ok === true,
      message: typeof raw.lastTest.message === 'string' ? raw.lastTest.message : '',
      at: typeof raw.lastTest.at === 'string' ? raw.lastTest.at : new Date().toISOString(),
    }
  }
  return config
}

export class SettingsStore {
  private settings: AppSettings

  constructor(private file: string) {
    const raw = readJson<SettingsFile>(file)
    // settings.json 损坏：先备份再按默认值继续（data/ 层的统一承诺）
    if (raw === undefined && fs.existsSync(file)) backupCorruptSettings(file)
    this.settings = normalize(raw?.settings)
  }

  get(): AppSettings {
    return { ...this.settings }
  }

  update(patch: Partial<AppSettings>): AppSettings {
    const next: Partial<AppSettings> = {}
    if (patch.deliver !== undefined && DELIVERS.includes(patch.deliver)) next.deliver = patch.deliver
    if (patch.defaultProject !== undefined && DEFAULT_PROJECTS.includes(patch.defaultProject)) {
      next.defaultProject = patch.defaultProject
    }
    if (patch.usageEnabled !== undefined) next.usageEnabled = Boolean(patch.usageEnabled)
    if (patch.customProvider !== undefined) next.customProvider = normalizeProvider(patch.customProvider)
    if (patch.mcpReadOnly !== undefined) next.mcpReadOnly = Boolean(patch.mcpReadOnly)
    if (patch.mcpScan !== undefined) next.mcpScan = Boolean(patch.mcpScan)
    if (patch.autoUpdateCheck !== undefined) next.autoUpdateCheck = Boolean(patch.autoUpdateCheck)
    if (patch.toolClients !== undefined) {
      // 整表替换（renderer 发的是完整表）：删掉最后一个偏好时也要能落盘
      const clients = normalizeToolClients(patch.toolClients)
      if (clients) next.toolClients = clients
      else next.toolClients = undefined
    }
    this.settings = { ...this.settings, ...next }
    this.save()
    return this.get()
  }

  private save(): void {
    atomicWriteJson(this.file, { version: 1, settings: this.settings } satisfies SettingsFile)
  }
}

function backupCorruptSettings(file: string): void {
  try {
    const backup = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`
    fs.copyFileSync(file, backup)
    try {
      fs.chmodSync(backup, 0o600)
    } catch {
      /* 忽略 */
    }
  } catch {
    /* 备份失败不阻塞启动 */
  }
}

function normalize(raw: Partial<AppSettings> | undefined): AppSettings {
  const s = { ...DEFAULT_SETTINGS }
  if (raw?.deliver && DELIVERS.includes(raw.deliver)) s.deliver = raw.deliver
  if (raw?.defaultProject && DEFAULT_PROJECTS.includes(raw.defaultProject)) {
    s.defaultProject = raw.defaultProject
  }
  if (typeof raw?.usageEnabled === 'boolean') s.usageEnabled = raw.usageEnabled
  if (raw?.customProvider !== undefined) s.customProvider = normalizeProvider(raw.customProvider)
  if (typeof raw?.mcpReadOnly === 'boolean') s.mcpReadOnly = raw.mcpReadOnly
  if (typeof raw?.mcpScan === 'boolean') s.mcpScan = raw.mcpScan
  // 旧 settings.json 没有这个字段：按默认值（开）处理，不把老配置当成「关」
  if (typeof raw?.autoUpdateCheck === 'boolean') s.autoUpdateCheck = raw.autoUpdateCheck
  const clients = normalizeToolClients(raw?.toolClients)
  if (clients) s.toolClients = clients
  return s
}
