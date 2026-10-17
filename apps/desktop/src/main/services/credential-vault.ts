/**
 * CredentialVault — 自配 provider 的 apiKey 保险库（PRD F5 来源 2）。
 *
 * 凭据纪律（TECH-ARCH §7/§9）：
 *  - Key 只经 Electron `safeStorage`（macOS 上由系统钥匙串派生加密密钥）加密后落盘；
 *  - 密文放 **userData**（`~/Library/Application Support/Tick/`），**永不进 `~/.ticktodo/data/`**，
 *    也就不会被 dotfiles/网盘同步带走；
 *  - 文件 0600 + 原子写，与 data/ 层的纪律一致。
 *
 * 注意：safeStorage 必须 app ready 之后才能用；构造时只记路径，首次读写时才触碰。
 */

import { safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { atomicWriteJson, readJson } from './storage'

interface VaultFile {
  version: 1
  /** safeStorage.encryptString 后的 base64 */
  encrypted: string
}

export class CredentialVault {
  private readonly file: string

  constructor(userDataDir: string) {
    this.file = path.join(userDataDir, 'credentials.json')
  }

  /** 可读性开关：OS 不支持加密时直接拒绝，不降级到明文（Key 纪律优先于可用性） */
  isAvailable(): boolean {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  hasKey(): boolean {
    return fs.existsSync(this.file)
  }

  /** 读出明文 key；没有/解密失败一律 undefined（失败不留半个可用状态） */
  readKey(): string | undefined {
    if (!this.isAvailable()) return undefined
    try {
      const parsed = readJson<VaultFile>(this.file)
      if (!parsed?.encrypted) return undefined
      return safeStorage.decryptString(Buffer.from(parsed.encrypted, 'base64'))
    } catch {
      return undefined
    }
  }

  /** 保存（覆盖）；加密不可用时报错，调用方负责把错误转成 UI 提示 */
  saveKey(apiKey: string): void {
    if (!this.isAvailable()) {
      throw new Error('系统钥匙串不可用，无法安全保存 API Key（不降级为明文）')
    }
    const encrypted = safeStorage.encryptString(apiKey).toString('base64')
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
    atomicWriteJson(this.file, { version: 1, encrypted } satisfies VaultFile)
  }

  deleteKey(): void {
    try {
      fs.rmSync(this.file, { force: true })
    } catch {
      /* 忽略：删除失败视为已删，下次读会失败返回 undefined */
    }
  }
}
