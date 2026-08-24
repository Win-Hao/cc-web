/**
 * M8 / D6：token 生成与持久化。
 *
 * 存 ~/.cc-web/server.token，权限 0600。用 hex —— WS 子协议只接受
 * RFC6455 token 字符，标准 base64 的 + / = 会出问题（API.md）。
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

/** 有文件读文件（重启复用），没有就生成 32 字节 hex 写 0600。 */
export function loadOrCreateToken(path: string): string {
  if (existsSync(path)) {
    const token = readFileSync(path, 'utf8').trim()
    if (token !== '') return token
    // 文件存在但空 —— 视为没初始化，落到生成分支覆盖
  }
  const token = randomBytes(32).toString('hex')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, token + '\n', { mode: 0o600 })
  return token
}
