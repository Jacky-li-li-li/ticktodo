/**
 * 错误信封（`docs/mcp-tools-spec.md` §1.3 / §1.5）。
 *
 * 业务失败一律 `isError: true`（不是 JSON-RPC error）；`content[0].text` 以 `[CODE]` 开头，
 * 让不支持 structuredContent 的客户端也能读出错误码。schema 校验失败在进入 handler 之前
 * 由 SDK 回 -32602，不经过这里。
 */

import type { CallToolResult } from '@modelcontextprotocol/server'

export interface ErrorShape {
  code: string
  message: string
  retryable: boolean
  retryAfterSeconds?: number
  next: string
}

export interface FailureOptions {
  retryAfterSeconds?: number
}

/** error.message 面向模型，不超过 200 字；next 必填（下一步动作） */
export function failure(
  code: string,
  message: string,
  next: string,
  retryable: boolean,
  options: FailureOptions = {},
): CallToolResult {
  const trimmedMessage = message.length > 200 ? `${message.slice(0, 199)}…` : message
  const error: ErrorShape = {
    code,
    message: trimmedMessage,
    retryable,
    ...(options.retryAfterSeconds !== undefined
      ? { retryAfterSeconds: Math.max(1, Math.ceil(options.retryAfterSeconds)) }
      : {}),
    next,
  }
  const text = `[${code}] ${trimmedMessage}。${next}`
  return {
    content: [{ type: 'text', text }],
    structuredContent: { ok: false, error },
    isError: true,
  }
}

export function success(text: string, structured: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent: { ok: true, ...structured },
  }
}

/** 结果文本 ≤20KB（spec §1.3）；超长时截断中段并注明 */
export function clampText(text: string, maxBytes = 20 * 1024): string {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= maxBytes) return text
  const head = buf.subarray(0, Math.floor(maxBytes / 2)).toString('utf8')
  const tail = buf.subarray(buf.length - Math.floor(maxBytes / 2)).toString('utf8')
  return `${head}\n…${buf.length - maxBytes} bytes truncated…\n${tail}`
}
