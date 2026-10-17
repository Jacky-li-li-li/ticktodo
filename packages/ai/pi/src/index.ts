/**
 * @tick/ai-pi — PiAdapter（M1 主体实装）。
 *
 * pi 官方规范实证：docs/已对齐/RESEARCH-pi.md（pi 事实以此为准）。
 * M0 状态：detect() 可用（探测可执行 + 版本），其余为 M1 占位。
 *
 * 实装要点备忘（TECH-ARCH §6.2 三个陷阱）：
 *  1. 路径可被覆盖：$PI_CODING_AGENT_DIR → $PI_CODING_AGENT_SESSION_DIR → settings.json 的
 *     sessionDir（jsonc，不能 JSON.parse）；settings 生效时是「所有 session 平铺一个目录」形态。
 *  2. 目录缓存 racy 窗口（约 2s）：verify() 必须绕缓存直读，且 size===0 视为未产生
 *     （本机有 31 个 0 字节 .jsonl 僵尸）。
 *  3. getDefaultSessionDir() 会 mkdirSync —— spawn 时 cwd 传错会凭空造出项目目录，绝不调用探测性路径。
 */

import { execFile } from 'node:child_process'
import os from 'node:os'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const MIN_PI_VERSION = '1.3.0'

/** pi 官方会话目录（fallback；实际路径需按上面备忘解析覆盖 env/settings） */
export const DEFAULT_PI_SESSION_DIR = `${os.homedir()}/.pi/agent/sessions`

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

export class PiAdapter /* implements AiToolAdapter（M1 补齐 discoverProjects/listSessions/launch/resume/verify） */ {
  readonly id = 'pi'

  private cachedVersion: string | null = null

  /**
   * 就绪探测。Q14 修订：未安装 = 引导空态「双出口」（去装 pi 或去自配 provider），
   * 不是死路。Todo 手动路径 / 导出照常可用，CLI 拉起与项目索引随之不可用（与凭据无关）。
   */
  async detect(): Promise<{ installed: boolean; version?: string; reason?: string }> {
    try {
      const { stdout } = await execFileAsync('pi', ['--version'])
      const version = stdout.trim().split(/\s+/).pop() ?? ''
      this.cachedVersion = version
      if (compareVersions(version, MIN_PI_VERSION) < 0) {
        return { installed: true, version, reason: `pi ${version} 低于要求的 ${MIN_PI_VERSION}（M0 要求升级）` }
      }
      return { installed: true, version }
    } catch {
      return { installed: false, reason: '未检测到 pi 可执行文件' }
    }
  }

  /**
   * 版本校验（M1 在 launch/resume 前调用；库升级后需重核）。
   * CLI trips（RESEARCH-pi 实证）：位置参数=启动消息 / --session-id / --session / --session-dir /
   * --name / -e；无 --cwd（spawn 工作目录决定）。
   */
  async readVersion(): Promise<string | null> {
    if (this.cachedVersion) return this.cachedVersion
    const r = await this.detect()
    return r.version ?? null
  }

  /**
   * M1 实装。argv 组装必须固定数组（业务规则 8：禁止 shell 字符串拼接），
   * sessionId 在 argv 与文件名里都会出现，字符集校验仍要做。
   */
  async launch(): Promise<never> {
    throw new Error('PiAdapter.launch: M1 实装')
  }

  async resume(): Promise<never> {
    throw new Error('PiAdapter.resume: M1 实装（pi --session <id>）')
  }
}

export const piAdapter = new PiAdapter()
