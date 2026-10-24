/**
 * ProviderConfigService — 自配 provider 的编排（PRD F5 来源 2 / M3 尾巴）。
 *
 * 职责边界（凭据纪律）：
 *  - **非敏感**（endpoint / 模型名 / 展示名 / keyStored 标记）→ settings.json（data/ 同步层）
 *  - **敏感**（apiKey）→ CredentialVault（safeStorage → userData，不进 data/）
 *  - 连接测试用输入框里的值直连，**不落盘**；成功时顺带拉 /models 供 UI 回填选择
 */

import type { CustomProviderConfig, ProviderSaveInput, ProviderTestResult } from '@tick/shared'
import type OpenAI from 'openai'
import type { SettingsStore } from './settings-store'
import type { CredentialVault } from './credential-vault'

/** 归一化 endpoint：补全协议头（用户常填 api.openai.com 不带 https://） */
export function normalizeBaseUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const url = new URL(withScheme)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.origin + url.pathname.replace(/\/+$/, '')
  } catch {
    return null
  }
}

export interface ProviderTestInput {
  baseUrl: string
  apiKey?: string
  /** 用户已填的模型 id；测试成功且 /models 里没有它时用于提示 */
  model?: string
}

export class ProviderConfigService {
  constructor(
    private settings: SettingsStore,
    private vault: CredentialVault,
  ) {}

  /** 当前配置（不含 key）。null = 跟随 pi 凭据 */
  get(): CustomProviderConfig | null {
    return this.settings.get().customProvider ?? null
  }

  /** 面板对话的凭据来源（chat-host 构造参数） */
  chatCredentialSource(): { kind: 'custom'; config: CustomProviderConfig; apiKey: string } | undefined {
    const config = this.get()
    if (!config) return undefined
    const apiKey = this.vault.readKey()
    if (!apiKey) return undefined
    return { kind: 'custom', config, apiKey }
  }

  /** 保存：key 进钥匙串、非敏感进 settings；返回新配置。抛错时调用方转成 UI 提示。 */
  save(input: ProviderSaveInput): CustomProviderConfig {
    const baseUrl = normalizeBaseUrl(input.baseUrl)
    if (!baseUrl) throw new Error('Endpoint 不是合法的 http(s) 地址')
    const model = input.model.trim()
    if (!model) throw new Error('模型名不能为空')

    if (input.apiKey !== undefined && input.apiKey.trim() !== '') {
      this.vault.saveKey(input.apiKey.trim())
    } else if (this.vault.readKey() === undefined) {
      // 用 readKey 判定而不是「文件存在」：密文损坏时也能在这里给出明确指引，而不是存完才发现面板不可用
      throw new Error('还没有保存过 API Key（首次保存需要填写）')
    }

    const prev = this.get()
    const config: CustomProviderConfig = {
      baseUrl,
      model,
      name: input.name?.trim() || prev?.name || undefined,
      keyStored: this.vault.readKey() !== undefined,
    }
    this.settings.update({ customProvider: config })
    return config
  }

  /** 清除自配：key 与配置一起删，回到 pi 凭据 */
  clear(): void {
    this.vault.deleteKey()
    this.settings.update({ customProvider: null })
  }

  /**
   * 连接测试（不落盘）：GET {baseUrl}/models 探测 OpenAl 兼容性并拉模型列表。
   * 网关不支持 /models 时退到 1-token chat completion 探测。
   */
  async test(input: ProviderTestInput): Promise<ProviderTestResult> {
    const baseUrl = normalizeBaseUrl(input.baseUrl)
    if (!baseUrl) return { ok: false, message: 'Endpoint 不是合法的 http(s) 地址' }
    const apiKey = input.apiKey?.trim()
    if (!apiKey) return { ok: false, message: '先填 API Key 再测试' }

    const { OpenAI } = await import('openai')
    // maxRetries 0：测试要快速失败给反馈，不重试（openai SDK 默认对 401 也重试，体验很糟）
    const client = new OpenAI({ baseURL: baseUrl, apiKey, timeout: 10_000, maxRetries: 0 })

    try {
      const res = await client.models.list()
      const models = res.data.map((m) => m.id).filter(Boolean)
      if (models.length) return { ok: true, message: `已连接，可用的模型 ${models.length} 个`, models }
      return { ok: true, message: `已连接，但 /models 没返回可用模型` }
    } catch (err) {
      // 部分网关没有 /models：退到 1-token 补全探测。
      // 模型未填时无法探测，直接报 /models 的真实失败原因。
      if (!input.model?.trim()) return { ok: false, message: describeError(err) }
      const probe = await probeChat(client, input.model)
      if (probe.ok) return { ok: true, message: probe.message, models: probe.models }
      return { ok: false, message: probe.message }
    }
  }
}

async function probeChat(
  client: Pick<OpenAI, 'chat'>,
  model: string | undefined,
): Promise<{ ok: true; message: string; models: string[] } | { ok: false; message: string }> {
  if (!model) return { ok: false, message: '模型未填，且 /models 不可用' }
  try {
    await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1,
    })
    return { ok: true, message: `已连接（/models 不可用，chat completion 探测通过）`, models: [model] }
  } catch (err) {
    return { ok: false, message: describeError(err) }
  }
}

/** 把网络/鉴权错误压缩成一句人话（面板里一行能放下） */
function describeError(err: unknown): string {
  const e = err as { status?: number; code?: string; name?: string; message?: string }
  if (e?.status === 401 || e?.status === 403) return '鉴权失败：检查 API Key'
  if (e?.status === 404) return '接口不存在：检查 Endpoint 是否以 /v1 结尾'
  if (e?.code === 'ECONNREFUSED') return '连不上：Endpoint 无法访问'
  if (e?.code === 'ENOTFOUND') return '域名解析失败：检查 Endpoint'
  if (e?.code === 'ETIMEDOUT' || /timed out|timeout/i.test(e?.name ?? '')) return '连接超时：检查网络或 Endpoint'
  return `连接失败：${e?.message?.slice(0, 80) ?? '未知错误'}`
}
