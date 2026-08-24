/**
 * id → jsonl 文件路径；以及轻量读会话 cwd。
 * id 白名单校验，防路径穿越。
 */
import { readdir, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'

export async function findSessionFile(root: string, id: string): Promise<string | null> {
  if (!/^[a-zA-Z0-9-]+$/.test(id)) return null
  for (const dir of await readdir(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    const p = join(root, dir.name, `${id}.jsonl`)
    const s = await stat(p).catch(() => null)
    if (s?.isFile()) return p
  }
  return null
}

/**
 * 流式读出头几行，拿到第一个 cwd 字段就停。
 * D3：resume 时引擎 spawn 的 cwd 必须设成它，否则 CLAUDE.md、
 * 相对路径、git 上下文全错。
 */
export async function readSessionCwd(path: string): Promise<string | null> {
  const rl = createInterface({
    input: createReadStream(path, 'utf8'),
    crlfDelay: Infinity,
  })
  try {
    for await (const line of rl) {
      if (line.trim() === '') continue
      try {
        const row = JSON.parse(line) as { cwd?: unknown }
        if (typeof row.cwd === 'string') return row.cwd
      } catch {
        // 坏行跳过，往下看
      }
    }
  } finally {
    rl.close()
  }
  return null
}
