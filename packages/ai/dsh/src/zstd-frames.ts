/**
 * zstd-frames — dsh 的多帧 zstd 文件读取。
 *
 * 为什么不能用现成 API（本机实测 2026-10-20）：
 *  - `zlib.zstdDecompressSync` **只解第一帧**；
 *  - `createZstdDecompress()` 只有在**每个帧单独 write()** 时才逐帧解，一次 `end(整个文件)` 也只解第一帧。
 *  dsh 的 10MB 会话文件里有 **23,331 个帧**（每批追加一个），所以必须自己切帧。
 *
 * 切帧不需要解压：按 zstd 规范读帧头 + 每个块的 3 字节块头（last/type/size）即可精确算出帧边界
 * （RLE 块负载 1 字节，其余为块头里的 size；可选 checksum 4 字节）。
 * 不用「按 magic 切」——压缩数据里出现 magic 字节是合法的，会切错。
 *
 * 上限（防止异常文件打满内存）：单文件 ≤ 128MB 压缩、总解压 ≤ 512MB、帧数 ≤ 200,000。
 */

import { openSync, readSync, closeSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { StringDecoder } from 'node:string_decoder'

const ZSTD_MAGIC = 0xfd2fb528
const SKIP_MAGIC_MIN = 0x184d2a50
const SKIP_MAGIC_MAX = 0x184d2a5f

const MAX_COMPRESSED = 128 * 1024 * 1024
const MAX_DECOMPRESSED = 512 * 1024 * 1024
const MAX_FRAMES = 200_000

export interface Frame {
  start: number
  end: number
  /** true = skippable frame（zstd 允许，解压时跳过） */
  skippable: boolean
}

/**
 * 从 buf 里切出 zstd 帧（`from` 起）。遇到坏 magic / 截断帧就停，返回已解析的部分。
 * 只读头部，不解压。
 */
export function splitFrames(buf: Buffer, from = 0): { frames: Frame[]; truncated: boolean } {
  const frames: Frame[] = []
  let off = from
  while (off + 4 <= buf.length && frames.length < MAX_FRAMES) {
    const magic = buf.readUInt32LE(off)
    if (magic >= SKIP_MAGIC_MIN && magic <= SKIP_MAGIC_MAX) {
      if (off + 8 > buf.length) return { frames, truncated: true }
      const size = buf.readUInt32LE(off + 4)
      const end = off + 8 + size
      if (end > buf.length) return { frames, truncated: true }
      frames.push({ start: off, end, skippable: true })
      off = end
      continue
    }
    if (magic !== ZSTD_MAGIC) return { frames, truncated: off !== buf.length }

    let p = off + 4
    if (p >= buf.length) return { frames, truncated: true }
    const fhd = buf[p] as number
    p += 1
    const fcsFlag = fhd >> 6
    const singleSegment = (fhd >> 5) & 1
    const checksum = (fhd >> 2) & 1
    const dictFlag = fhd & 3
    if (!singleSegment) p += 1 // Window_Descriptor
    p += dictFlag === 3 ? 4 : dictFlag // Dictionary_ID
    p += fcsFlag === 0 ? (singleSegment ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8

    for (;;) {
      if (p + 3 > buf.length) return { frames, truncated: true }
      // ⚠️ 块头只有 3 字节：读 4 字节会把下一块的字节算进来（size 变巨大）
      const h = (buf[p] as number) | ((buf[p + 1] as number) << 8) | ((buf[p + 2] as number) << 16)
      p += 3
      const last = h & 1
      const type = (h >> 1) & 3
      const size = h >>> 3
      // type 1 = RLE，负载只有 1 字节；type 0/2 负载 = size；type 3 保留（按 size 跳过）
      p += type === 1 ? 1 : size
      if (p > buf.length) return { frames, truncated: true }
      if (last) break
    }
    if (checksum) p += 4
    if (p > buf.length) return { frames, truncated: true }
    frames.push({ start: off, end: p, skippable: false })
    off = p
  }
  return { frames, truncated: off !== buf.length }
}

/** 读文件头部若干字节（给「只读第一帧」的快速路径用；首帧远小于此） */
function readHead(file: string, bytes: number): Buffer {
  const fd = openSync(file, 'r')
  try {
    const size = Math.min(statSync(file).size, bytes)
    const buf = Buffer.alloc(size)
    const n = readSync(fd, buf, 0, size, 0)
    return buf.subarray(0, n)
  } finally {
    closeSync(fd)
  }
}

/**
 * 只读第一帧并解压（拿会话 header：id / cwd / createdAt / delegationDepth / parentSession）。
 *
 * 为什么从 64KB 起步再按需加倍（改造前固定读 1MB）：首帧实测只有 187–207 字节，
 * 而列 87 个会话会读 87 × 1MB = 55MB —— 全部是白读。现在一次列表只碰 87 × 64KB ≈ 5.5MB，
 * 首帧异常大时才会翻倍。上限 4MB 兜住「文件头是垃圾数据」的异常文件（否则会一路翻到 128MB）。
 */
const FIRST_FRAME_START_BYTES = 64 * 1024
/** 首帧解压上限 64MB：首帧只是 header（压缩后上限 8MB 也远大于实测 200B），不让异常文件瞬时吃 512MB */
const FIRST_FRAME_MAX_OUTPUT = 64 * 1024 * 1024
/**
 * 首帧上限 8MB（第二轮是 4MB）：首帧正常只有 ~200B，4MB 已远超；但超过上限会让**整条会话静默消失**，
 * 所以放宽一档给异常/大 header 的会话留余量，同时由 `collectDshSessions` 把跳过数量记进日志（不含 id）。
 */
const FIRST_FRAME_MAX_BYTES = 8 * 1024 * 1024

export function readFirstFrameText(file: string): string | undefined {
  let size: number
  try {
    size = statSync(file).size
  } catch {
    return undefined
  }
  let bytes = Math.min(size, FIRST_FRAME_START_BYTES)
  for (;;) {
    const head = readHead(file, bytes)
    const { frames } = splitFrames(head)
    const first = frames.find((f) => !f.skippable)
    if (first && first.end <= head.length) {
      try {
        // maxOutputLength 兜住异常帧：首帧只是 header，不需要整份 512MB 的解压上限
        return zstdDecompressSync(head.subarray(first.start, first.end), {
          maxOutputLength: FIRST_FRAME_MAX_OUTPUT,
        }).toString('utf8')
      } catch {
        return undefined
      }
    }
    if (bytes >= size || bytes >= FIRST_FRAME_MAX_BYTES) return undefined
    bytes = Math.min(size, bytes * 2)
  }
}

/** 逐行回调（按帧解压，解压完立即丢弃原始帧） */
export interface ReadLinesOptions {
  maxCompressedBytes?: number
  maxDecompressedBytes?: number
  /** 最多读多少个帧（「只找首条用户消息/模型」这类快路径用） */
  maxFrames?: number
  /**
   * 只读文件前 N 字节（快路径用）。缺省 = 整份。
   * 为什么需要：peek 只要开头 32 帧，而改造前 `readFrameLines` 第一步就是 `readHead(file, size)`，
   * 把整份压缩文件读进内存（本机 41 个根会话 69.5MB/次列表）——只取前缀即可。
   */
  prefixBytes?: number
  /** 返回 false 提前结束（例如只要首条消息时） */
  onLine?: (line: string) => boolean | void
}

/**
 * 读整个多帧文件的每一行（已解压）。返回实际解压出的字节数与是否被上限截断。
 * 只用于 `describeSession` 这种按需场景：本机最大会话 10MB 压缩 / 26MB 解压 / 23k 帧，实测 ~0.5s。
 */
export function readFrameLines(
  file: string,
  opts: ReadLinesOptions = {},
): { bytes: number; lines: number; frames: number; truncated: boolean } {
  const maxCompressed = opts.maxCompressedBytes ?? MAX_COMPRESSED
  const maxDecompressed = opts.maxDecompressedBytes ?? MAX_DECOMPRESSED
  let size: number
  try {
    size = statSync(file).size
  } catch {
    return { bytes: 0, lines: 0, frames: 0, truncated: false }
  }
  if (size > maxCompressed) return { bytes: 0, lines: 0, frames: 0, truncated: true }

  const buf = readHead(file, Math.min(size, opts.prefixBytes ?? size))
  const { frames, truncated } = splitFrames(buf)
  let bytes = 0
  let lines = 0
  let read = 0
  let stopped = false
  const maxFrames = opts.maxFrames ?? Number.POSITIVE_INFINITY
  for (const frame of frames) {
    if (frame.skippable) continue
    if (read >= maxFrames) {
      stopped = true
      break
    }
    read += 1
    let text: string
    try {
      const out = zstdDecompressSync(buf.subarray(frame.start, frame.end), {
        maxOutputLength: maxDecompressed,
      })
      bytes += out.length
      if (bytes > maxDecompressed) return { bytes, lines, frames: read, truncated: true }
      text = out.toString('utf8')
    } catch {
      // 单帧坏了不影响前面的内容（写入中的末帧可能不完整）
      continue
    }
    for (const line of text.split('\n')) {
      if (!line) continue
      lines += 1
      if (opts.onLine?.(line) === false) {
        stopped = true
        break
      }
    }
    if (stopped) break
  }
  return { bytes, lines, frames: read, truncated: truncated || stopped }
}

/**
 * 未压缩的 `session.jsonl`（dsh 关掉压缩时）：按行流式读。
 * 与 `readFrameLines` 同参数语义（`maxFrames` 这边按「行」限流，用于快路径）。
 */
export function readPlainLines(
  file: string,
  opts: ReadLinesOptions = {},
): { bytes: number; lines: number; frames: number; truncated: boolean } {
  const maxDecompressed = opts.maxDecompressedBytes ?? MAX_DECOMPRESSED
  const maxFrames = opts.maxFrames ?? Number.POSITIVE_INFINITY
  let bytes = 0
  let lines = 0
  let truncated = false
  let fd: number | undefined
  try {
    fd = openSync(file, 'r')
    const size = statSync(file).size
    if (size > MAX_COMPRESSED) return { bytes: 0, lines: 0, frames: 0, truncated: true }
    const buf = Buffer.alloc(256 * 1024)
    // 为什么用 StringDecoder：按块各自 toString('utf8') 会把跨块边界的多字节字符
    // （中文/emoji）解成 U+FFFD，污染 first/lastMessage；StringDecoder 会缓存半个码点留给下一块。
    const decoder = new StringDecoder('utf8')
    let pending = ''
    let pos = 0
    while (pos < size) {
      const n = readSync(fd, buf, 0, Math.min(buf.length, size - pos), pos)
      if (n <= 0) break
      pos += n
      pending += decoder.write(buf.subarray(0, n))
      bytes += n
      if (bytes > maxDecompressed) {
        truncated = true
        break
      }
      let idx = pending.indexOf('\n')
      while (idx >= 0) {
        const line = pending.slice(0, idx)
        pending = pending.slice(idx + 1)
        if (line) {
          lines += 1
          if (opts.onLine?.(line) === false) {
            truncated = true
            return { bytes, lines, frames: lines, truncated }
          }
          if (lines >= maxFrames) return { bytes, lines, frames: lines, truncated: true }
        }
        idx = pending.indexOf('\n')
      }
    }
    // 收尾：把 decoder 里缓存的半个码点冲出来（文件末尾被截断时也不会丢行）
    pending += decoder.end()
    if (pending) {
      lines += 1
      if (opts.onLine?.(pending) === false) truncated = true
    }
  } catch {
    /* 读失败：返回已读部分 */
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  return { bytes, lines, frames: lines, truncated }
}
