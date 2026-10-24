/**
 * ChatAgentHost — 面板 Chat 的执行层（PRD F5 / TECH-ARCH §7 D13 定案）。
 *
 * 组成：
 *  - **pi-durable@1.3.0**（pin：Experimental）的 `Harness`，JSONL storage 落
 *    `~/.ticktodo/sessions/panel-chat/`（不同步层，与 CliSessionId 命名空间隔离）
 *  - **pi 本体的模型目录与凭据**：`ModelRuntime.create()` 直接读 pi 的
 *    `models.json` / `auth.json` / `models-store.json`，不需要 Tick 自己存 key
 *  - **tick-extension** 的工具（create_todo / list_todos）经 registry 注入
 *
 * 不做的：面板用量统计（D15：pi.usage 有但不读）。
 */

import { existsSync } from 'node:fs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { Harness, createRegistry, type Conversation, type ConversationView } from '@earendil-works/pi-durable'
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node'
import type { Credential, CredentialInfo, CredentialStore, Models } from '@earendil-works/pi-ai'
import type { ChatMessage, ChatState, CustomProviderConfig } from '@tick/shared'
import { parseJsonc } from '@tick/ai-pi'
import { TickDurableExtension } from '@tick/tick-extension/durable'

/** pi-durable 的 view 是 Chord 的 AttachedReplicatedState：subscribe 回调收到 ConversationView */
type AttachedView = Awaited<ReturnType<Conversation['viewState']>>
type View = ConversationView

export interface ChatHostDeps {
  /** `~/.ticktodo/sessions/panel-chat` */
  storageDir: string
  /** 状态变化推给 renderer（已经做过节流/合并） */
  onState: (state: ChatState) => void
  /** 注入以便测试：默认用 pi 的 ModelRuntime */
  createModels?: () => Promise<Models>
  /** 指定模型（设置里选过的那个）；缺省按 pi 的默认 → 该 provider 的第一个可用 */
  preferredModel?: { provider: string; id: string }
  /**
   * 凭据来源（M3 尾巴 / PRD F5 来源 2）：
   * 缺省 = pi 本体（零配置）；custom = 自配 OpenAI 兼容 endpoint（key 已在内存，不再落盘）。
   * 来源切换需要重建 host（main 侧 reloadChat），durable 会话历史不受影响。
   */
  credentialSource?: { kind: 'custom'; config: CustomProviderConfig; apiKey: string }
}

export class ChatAgentHost {
  private models?: Models
  private harness?: Harness
  private root?: Conversation
  private view?: AttachedView
  private state: ChatState = { status: 'unavailable', messages: [] }
  private closed = false

  constructor(private deps: ChatHostDeps) {}

  getState(): ChatState {
    return this.state
  }

  private publish(next: Partial<ChatState>): void {
    this.state = { ...this.state, ...next }
    if (!this.closed) this.deps.onState(this.state)
  }

  /**
   * 初始化：拿模型目录 → 开 Harness → 建根会话 → 订阅 view。
   * 任何一步失败都停在 status='unavailable' 并带上原因（UI 只显示一行说明，不做安装引导）。
   */
  async init(): Promise<void> {
    try {
      fs.mkdirSync(this.deps.storageDir, { recursive: true, mode: 0o700 })

      const source = this.deps.credentialSource
      const models = this.deps.createModels
        ? await this.deps.createModels()
        : source?.kind === 'custom'
          ? await customProviderModels(source.config, source.apiKey)
          : await defaultModels()

      const available = await models.getAvailable()
      if (available.length === 0) {
        console.warn('[tick] 面板对话不可用：没有可用凭据')
        this.publish({
          status: 'unavailable',
          source: source?.kind === 'custom' ? 'custom' : 'pi',
          reason:
            source?.kind === 'custom'
              ? '自配 provider 未通过可用性检查（去设置里“测试连接”）'
              : '未检测到可用的模型凭据（pi auth 里没有可用的 provider）',
        })
        return
      }

      const preferred =
        source?.kind === 'custom'
          ? { provider: CUSTOM_PROVIDER_ID, id: source.config.model }
          : this.deps.preferredModel
      const picked = pickModel(models, available, preferred, source?.kind === 'custom')
      if (!picked) {
        this.publish({ status: 'unavailable', reason: 'pi 的模型目录为空' })
        return
      }
      this.models = models

      const registry = createRegistry()
      registry.install(TickDurableExtension)

      const storage = await openNodeJsonlStorage(this.deps.storageDir, BACKGROUND_CONTEXT)
      const harness = await Harness.open(
        storage,
        {
          models,
          registry,
          settings: {
            // 模型请求必须能失败：不给超时的话，网络挂起会让 run 永远 busy，
            // 后续消息全部排队（resume 后也不会好转）。120s 对长回复足够。
            stream: { timeoutMs: 120_000 },
          },
          // durable 内部吞掉的失败（hook 抛错、session 失败）必须留痕，否则面板“busy 到永远”无法排查
          onReport: (error) => console.error('[tick] durable report:', error),
        },
        BACKGROUND_CONTEXT,
      )
      this.harness = harness

      this.root = await harness.root(BACKGROUND_CONTEXT, {
        agent: { model: { provider: picked.provider, modelId: picked.id }, cwd: os.homedir() },
      })
      // 崩溃续跑：上次进程没跑完的 run / tool 从这里接上
      harness.resume()

      this.view = await this.root.viewState(BACKGROUND_CONTEXT)
      this.view.subscribe((value) => this.renderView(value))

      this.publish({
        status: 'idle',
        model: `${picked.provider}/${picked.id}`,
        cwd: os.homedir(),
        source: source?.kind === 'custom' ? 'custom' : 'pi',
        reason: undefined,
      })
    } catch (err) {
      console.error('[tick] 面板对话初始化失败:', err)
      this.publish({
        status: 'unavailable',
        reason: `面板对话初始化失败：${(err as Error).message}`,
      })
    }
  }

  /** 把 pi-durable 的 view 拍平成 UI 需要的三种东西：消息、流式尾、忙闲 */
  private renderView(value: View): void {
    const messages: ChatMessage[] = []
    for (const entry of value.entries) {
      const model = entry.model?.[0]
      if (!model) continue
      if (entry.kind === 'pi.user' && model.role === 'user') {
        messages.push({ id: String(entry.id), role: 'user', text: messageText(model) })
      } else if (entry.kind === 'pi.assistant' && model.role === 'assistant') {
        const text = messageText(model)
        if (text.trim()) messages.push({ id: String(entry.id), role: 'assistant', text })
      }
    }

    const live = value.docs['pi.live'] as
      | { run?: unknown; generation?: { message?: { content?: unknown } } }
      | undefined
    const busy = Boolean(live?.run)
    const partial = live?.generation?.message
      ? messageText({ role: 'assistant', content: live.generation.message.content } as never)
      : ''
    if (busy && partial.trim()) {
      messages.push({ id: '__streaming__', role: 'assistant', text: partial, streaming: true })
    }

    this.publish({
      status: busy ? 'busy' : this.state.status === 'unavailable' ? 'unavailable' : 'idle',
      messages,
    })
  }

  /** 发一条用户输入。requestId 由调用方给（UI 每次点击生成一个），重复提交不会双跑。 */
  async send(text: string, requestId = `panel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`): Promise<void> {
    if (!this.root) throw new Error(this.state.reason ?? '面板对话尚未就绪')
    const content = text.trim()
    if (!content) return
    const submission = await this.root.submit({ type: 'input', content, requestId }, BACKGROUND_CONTEXT)

    // 失败必须有反馈：模型/网络/凭据问题在 durable 里是 unanswered，不抛异常
    void submission.wait(BACKGROUND_CONTEXT).then(
      (settled) => {
        if (settled.status === 'unanswered') {
          const detail = settled.detail ? `（${JSON.stringify(settled.detail).slice(0, 300)}）` : ''
          this.publish({
            status: 'idle',
            messages: [
              ...this.state.messages,
              { id: `fail-${settled.id}`, role: 'assistant', text: `这轮没答出来：${settled.reason}${detail}` },
            ],
          })
        }
      },
      (err) => {
        this.publish({
          status: 'idle',
          messages: [
            ...this.state.messages,
            { id: `fail-${Date.now()}`, role: 'assistant', text: `这轮失败：${(err as Error).message}` },
          ],
        })
      },
    )
  }

  /** 切换面板对话的工作目录（PRD F5：默认 home，可切换） */
  async setCwd(cwd: string): Promise<void> {
    if (!this.root) throw new Error(this.state.reason ?? '面板对话尚未就绪')
    if (!existsSync(cwd)) throw new Error(`目录不存在：${cwd}`)
    await this.root.configure({ cwd }, BACKGROUND_CONTEXT)
    this.publish({ cwd })
  }

  /** 打断当前 run（保留已提交的部分） */
  async abort(): Promise<void> {
    await this.root?.abort(BACKGROUND_CONTEXT)
  }

  /** 开新会话：只改当前上下文起点，历史仍在（pi-durable 的 reset 语义） */
  async reset(): Promise<void> {
    if (!this.root) return
    await this.root.reset(undefined, BACKGROUND_CONTEXT)
    this.publish({ messages: [], status: 'idle' })
  }

  async close(): Promise<void> {
    this.closed = true
    try {
      this.view?.dispose?.()
    } catch {
      /* 忽略 */
    }
    await this.harness?.close(BACKGROUND_CONTEXT)
  }
}

/** 自配 provider 的注册 id（单一实例；未来逐工具凭据可扩展为 `<tool>-custom`） */
const CUSTOM_PROVIDER_ID = 'tick-custom'

/**
 * 自配 provider（PRD F5 来源 2）：内置 pi-ai 直连上游，不依赖 pi 本体。
 * 用 `ModelRuntime.registerProvider` 挂一个 OpenAI 兼容 provider：
 *  - `api` = 内置 `openai-completions`（/chat/completions，任意兼容网关都能接）
 *  - `baseUrl` + `apiKey` 直接进 provider config → auth 解析为「configured API key」，
 *    不需要 CredentialStore，key 不进任何文件（内存直连，落盘只存在于 safeStorage 密文）
 *  - 自配模型的价格未知 → cost 全 0（面板 Chat 不显示用量，口径一致）
 */
async function customProviderModels(config: CustomProviderConfig, apiKey: string): Promise<Models> {
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent')
  const runtime = await ModelRuntime.create({
    // 自配模型的 key 在 registerProvider 里（configured API key），不走 store；
    // store 用 pi 的只读凭据兜底：resume 历史会话（用 pi 模型的 run）时仍能跑，
    // 没装 pi 的用户这里读到空，自配模型照常工作。
    credentials: readOnlyPiCredentials(),
    refreshOnCreate: false,
    allowModelNetwork: false,
  })
  runtime.registerProvider(CUSTOM_PROVIDER_ID, {
    name: config.name?.trim() || '自定义',
    baseUrl: config.baseUrl,
    apiKey,
    api: 'openai-completions',
    models: [
      {
        id: config.model,
        name: config.model,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        reasoning: false,
        contextWindow: 200_000,
        maxTokens: 32_000,
      },
    ],
  })
  // 诊断代理：durable 的每次模型请求留痕（排查用，稳定后移除）
  return new Proxy(runtime, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (prop === 'streamSimple' || prop === 'stream') {
        return (model: { provider?: string; id?: string }, ...rest: unknown[]) => {
          console.log(`[tick][provider] ${String(prop)} → ${String(model?.provider)}/${String(model?.id)}`)
          return (value as (...args: unknown[]) => unknown).call(target, model, ...rest)
        }
      }
      return value
    },
  })
}

/**
 * 默认用 pi 本体的模型目录与凭据（不复制 key、不落盘）。
 *
 * **只读**：面板是凭据的消费者，不写 pi 的 auth.json。这样面板不需要抢 pi 的文件锁
 * （`auth.json.lock`），也就不会因为 pi 正在跑 / 锁目录残留而打不开对话。
 * 代价：OAuth 令牌的续期由 pi 本体负责——面板里若遇到过期令牌，会作为本轮错误显示出来。
 * （M3 的自配 provider 走 CredentialSource 的另一个实现，不复用这条路径。）
 */
async function defaultModels(): Promise<Models> {
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent')
  return ModelRuntime.create({
    credentials: readOnlyPiCredentials(),
    refreshOnCreate: false,
    allowModelNetwork: false,
  })
}

/** 只读 CredentialStore：read/list 直读 auth.json，modify/delete 明确不支持 */
function readOnlyPiCredentials(): CredentialStore {
  const authPath = path.join(
    process.env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), '.pi', 'agent'),
    'auth.json',
  )
  const load = (): Record<string, unknown> => {
    try {
      return JSON.parse(fs.readFileSync(authPath, 'utf8')) as Record<string, unknown>
    } catch {
      return {}
    }
  }
  return {
    read: async (providerId: string) => load()[providerId] as Credential | undefined,
    list: async () =>
      Object.entries(load()).map(([providerId, c]) => ({ providerId, ...(c as object) }) as CredentialInfo),
    modify: async () => {
      throw new Error('面板对 pi 凭据是只读的')
    },
    delete: async () => {
      throw new Error('面板对 pi 凭据是只读的')
    },
  }
}

/**
 * 选模型：优先 pi 的默认 provider/model，但**必须存在于当前目录**；
 * 默认值过期（provider 还叫 magpie、模型已下架）时退到该 provider 的第一个可用模型，再退到全局第一个。
 */
function pickModel(
  models: Models,
  available: readonly { provider: string; id: string }[],
  preferred?: { provider: string; id: string },
  skipPiSettings = false,
): { provider: string; id: string } | undefined {
  if (preferred) {
    const hit = available.find((m) => m.provider === preferred.provider && m.id === preferred.id)
    if (hit) return hit
  }
  if (!skipPiSettings) {
    const settings = readPiSettings()
    if (settings?.defaultProvider && settings.defaultModel) {
      const hit = available.find(
        (m) => m.provider === settings.defaultProvider && m.id === settings.defaultModel,
      )
      if (hit) return hit
      const sameProvider = available.find((m) => m.provider === settings.defaultProvider)
      if (sameProvider) return sameProvider
    }
  }
  return available[0]
}

function readPiSettings(): { defaultProvider?: string; defaultModel?: string } | undefined {
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), '.pi', 'agent')
  try {
    const raw = fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8')
    // pi 的 settings.json 是 jsonc（允许注释/尾逗号）——与 paths.ts 用同一个解析器，别用 JSON.parse
    const parsed = parseJsonc(raw) as { defaultProvider?: string; defaultModel?: string } | undefined
    return parsed
  } catch {
    return undefined
  }
}

/** 一条 pi 消息 → 纯文本（只取 text 块；tool_use 等不进面板） */
function messageText(message: { role?: string; content?: unknown }): string {
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type: string; text?: string } => Boolean(b) && typeof b === 'object')
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('')
}
