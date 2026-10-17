/**
 * SettingsStore — `~/.ticktodo/data/settings.json`（PRD F4-b 的两个开关 + F6-b 用量开关）。
 *
 * 数据层语义：settings 是「用户意图」，属于 data/（可同步）层；文件 0600，原子写。
 * 只做白名单字段合并，避免 renderer/旧版本写入未知字段把文件搞坏。
 */

import type { AppSettings, CustomProviderConfig, DefaultProjectSetting, LaunchDeliverSetting } from '@tick/shared'
import { DEFAULT_SETTINGS } from '@tick/shared'
import { atomicWriteJson, readJson } from './storage'

interface SettingsFile {
  version: 1
  settings: AppSettings
}

const DELIVERS: LaunchDeliverSetting[] = ['clipboard', 'argv']
const DEFAULT_PROJECTS: DefaultProjectSetting[] = ['home', 'recent', 'ask']

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
    this.settings = normalize(readJson<SettingsFile>(file)?.settings)
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
    this.settings = { ...this.settings, ...next }
    this.save()
    return this.get()
  }

  private save(): void {
    atomicWriteJson(this.file, { version: 1, settings: this.settings } satisfies SettingsFile)
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
  return s
}
