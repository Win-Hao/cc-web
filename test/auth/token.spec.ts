/**
 * M8：token 生成与持久化（D6）。
 * token 存 ~/.cc-web/server.token，权限 0600；
 * 用 hex —— WS 子协议只接受 RFC6455 token 字符，base64 的 +/= 会出问题。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, statSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadOrCreateToken } from '#/auth/token.js'

const tmpdirs: string[] = []
afterEach(() => {
  for (const d of tmpdirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function tokenPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cc-web-auth-'))
  tmpdirs.push(dir)
  return join(dir, 'nested', 'server.token') // 父目录也不存在，得自己建
}

describe('loadOrCreateToken', () => {
  it('首次启动生成 token，写文件，权限 0600', () => {
    const p = tokenPath()
    const token = loadOrCreateToken(p)
    expect(token.length).toBeGreaterThanOrEqual(32)
    expect(statSync(p).mode & 0o777).toBe(0o600)
    expect(readFileSync(p, 'utf8').trim()).toBe(token)
  })

  it('token 只用 RFC6455 安全字符（hex），能进 WS 子协议', () => {
    const token = loadOrCreateToken(tokenPath())
    expect(token).toMatch(/^[0-9a-f]+$/)
  })

  it('重启复用同一 token（第二次调用读文件，不重新生成）', () => {
    const p = tokenPath()
    const first = loadOrCreateToken(p)
    const second = loadOrCreateToken(p)
    expect(second).toBe(first)
  })
})
