/**
 * ProviderSettings — 自配 provider 表单（PRD F5 来源 2 / M3 尾巴）。
 *
 * 口径：
 *  - 切换来源 = 立即保存并重建面板对话（main 侧 reloadChat，durable 历史保留）
 *  - Key 只进钥匙串：输入框的值只经 provider:test / provider:save 传给 main，本地不留；
 *    已存 key 后输入框留空 = 不修改
 *  - 「测试连接」用当前输入值直连（不落盘），成功时拉回 /models 供下拉选择
 *  - 保存/清除成功后 main 广播 settings:changed，本组件靠 config prop 重新同步（不双写）
 */

import React, { useEffect, useState } from 'react'
import type { CustomProviderConfig, ProviderTestResult } from '@tick/shared'

export function ProviderSettings({
  config,
  onToast,
}: {
  /** null = 当前跟随 pi 凭据 */
  config: CustomProviderConfig | null
  onToast: (text: string) => void
}): React.JSX.Element {
  const [mode, setMode] = useState<'pi' | 'custom'>(config ? 'custom' : 'pi')
  const [name, setName] = useState(config?.name ?? '')
  const [baseUrl, setBaseUrl] = useState(config?.baseUrl ?? '')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState(config?.model ?? '')
  const [models, setModels] = useState<string[]>([])
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testResult, setTestResult] = useState<ProviderTestResult | null>(null)
  const [formError, setFormError] = useState('')

  // 外部 config 变化（保存/清除后 main 广播 settings:changed）时同步表单
  useEffect(() => {
    if (config) {
      setMode('custom')
      setName(config.name ?? '')
      setBaseUrl(config.baseUrl)
      setModel(config.model)
    } else {
      setMode('pi')
    }
    setApiKey('')
    setTestResult(null)
  }, [config])

  const markDirty = (): void => setFormError('')

  const test = async (): Promise<void> => {
    if (testing) return
    if (!baseUrl.trim() || !apiKey.trim()) {
      setFormError('Endpoint 和 API Key 都需要填')
      return
    }
    setTesting(true)
    try {
      const result = await window.tick.provider.test({
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        model: model.trim() || undefined,
      })
      setTestResult(result)
      if (result.ok && result.models?.length) setModels(result.models)
      onToast(result.ok ? `测试通过：${result.message}` : `测试失败：${result.message}`)
    } finally {
      setTesting(false)
    }
  }

  const save = async (): Promise<void> => {
    if (saving) return
    if (!baseUrl.trim() || !model.trim()) {
      setFormError('Endpoint 和模型名都需要填')
      return
    }
    setSaving(true)
    setFormError('')
    try {
      await window.tick.provider.save({
        name: name.trim() || undefined,
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        apiKey: apiKey.trim() || undefined,
      })
      setApiKey('')
      setTestResult(null)
      onToast('已保存，面板对话已切换到自配 provider')
      // 表单与最新 config 同步交给 main 的 settings:changed 广播（config prop 更新）
    } catch (e) {
      setFormError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const switchMode = async (next: 'pi' | 'custom'): Promise<void> => {
    setMode(next)
    if (next === 'pi' && config) {
      setSaving(true)
      try {
        await window.tick.provider.clear()
        setApiKey('')
        setModels([])
        setTestResult(null)
        onToast('已清除自配，面板对话回到 pi 凭据')
      } catch (e) {
        setFormError((e as Error).message)
        setMode('custom')
      } finally {
        setSaving(false)
      }
    }
  }

  return (
    <div>
      <div className="sheet-row deliver">
        <div className="segmented">
          <button className={mode === 'pi' ? 'on' : ''} onClick={() => void switchMode('pi')}>
            跟随 pi
          </button>
          <button className={mode === 'custom' ? 'on' : ''} onClick={() => void switchMode('custom')}>
            自配（OpenAI 兼容）
          </button>
        </div>
      </div>

      {mode === 'custom' ? (
        <div className="provider-form">
          <label className="provider-field">
            <span className="provider-label">Endpoint</span>
            <input
              className="text-input"
              placeholder="https://api.openai.com/v1 或任意网关地址"
              value={baseUrl}
              spellCheck={false}
              onChange={(e) => {
                setBaseUrl(e.target.value)
                markDirty()
              }}
            />
          </label>
          <label className="provider-field">
            <span className="provider-label">API Key</span>
            <input
              className="text-input"
              type="password"
              placeholder={config?.keyStored ? '已存入系统钥匙串（留空 = 不改）' : 'sk-…（只进系统钥匙串，不落 data/）'}
              value={apiKey}
              spellCheck={false}
              onChange={(e) => {
                setApiKey(e.target.value)
                markDirty()
              }}
            />
          </label>
          <label className="provider-field">
            <span className="provider-label">模型</span>
            {models.length > 0 ? (
              <select
                className="text-input"
                value={model}
                onChange={(e) => {
                  setModel(e.target.value)
                  markDirty()
                }}
              >
                {!models.includes(model) && model && <option value={model}>{model}</option>}
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="text-input"
                placeholder="模型 id（如 gpt-4o-mini），或先测试连接拉列表"
                value={model}
                spellCheck={false}
                onChange={(e) => {
                  setModel(e.target.value)
                  markDirty()
                }}
              />
            )}
          </label>
          <label className="provider-field">
            <span className="provider-label">名称（选填）</span>
            <input
              className="text-input"
              placeholder="显示用，如「公司网关」"
              value={name}
              spellCheck={false}
              onChange={(e) => {
                setName(e.target.value)
                markDirty()
              }}
            />
          </label>

          <div className="provider-actions">
            <button className="pill secondary" disabled={testing} onClick={() => void test()}>
              {testing ? '测试中…' : '测试连接'}
            </button>
            <button className="pill primary" disabled={saving} onClick={() => void save()}>
              {saving ? '保存中…' : '保存'}
            </button>
          </div>

          {formError && <div className="provider-error">{formError}</div>}
          {!formError && testResult && (
            <div className={`provider-status ${testResult.ok ? 'ok' : 'bad'}`}>{testResult.message}</div>
          )}

          <div className="sheet-note">
            Key 只经系统钥匙串加密存储（~/.ticktodo 与同步层里永远不出现 Key）；Endpoint 与模型名存
            settings.json。自配后面板 Chat 不再依赖 pi 本体，但 CLI 拉起与项目索引仍需要 pi。
          </div>
        </div>
      ) : (
        <div className="sheet-note">
          默认零配置：面板对话复用 pi 本体的模型与凭据（只读，不抢 pi 的文件锁）。pi 未登录时，
          可切到「自配」直连任意 OpenAI 兼容 endpoint。
        </div>
      )}
    </div>
  )
}
