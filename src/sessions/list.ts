/**
 * M2/M15：扫描 projects 根目录（~/.claude/projects），列出所有会话，按 mtime 倒序。
 *
 * 性能（M15）：不再整文件 parse —— 摘要只要 cwd + 首条人话，流式扫到
 * 两样都拿到就提前断流；mtime 没变的文件直接吃上次的扫描结果（进程内缓存）。
 * 代价是标题取「文件序」首条人话而不是 mainline（rewind 掉首条消息的
 * 极端情况会显示旧标题）——对列表摘要可接受。
 *
 * 每个会话的 cwd / 首条用户消息从 jsonl 内容里读（slug 不可逆，见 slug.ts
 * 注释）。空文件没有可读信息，对应字段给 null，不猜。
 */
import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { extractText, stripMetaBlocks } from './text.js'

export interface SessionSummary {
  /** 文件名去掉 .jsonl，即 session uuid */
  session_id: string
  project_slug: string
  /** 从 jsonl 行的 cwd 字段读；读不到（空文件）为 null */
  cwd: string | null
  /** 首条可提取的「人话」用户消息；没有为 null */
  first_message: string | null
  mtime_ms: number
}


interface ScanResult {
  cwd: string | null
  first_message: string | null
}

/**
 * 流式扫一个 jsonl：拿到 cwd + 首条人话就断流（大文件不用读完）。
 * 整个会话都是元信息（IDE 自动注入等）→ 退回首条的标签内文本。
 */
async function scanSessionFile(path: string): Promise<ScanResult> {
  let cwd: string | null = null
  let human: string | null = null
  let fallback: string | null = null

  const stream = createReadStream(path, 'utf8')
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const raw of rl) {
      if (raw.trim() === '') continue
      let row: unknown
      try {
        row = JSON.parse(raw)
      } catch {
        continue // 坏行跳过
      }
      if (typeof row !== 'object' || row === null) continue
      const r = row as Record<string, unknown>
      if (cwd === null && typeof r.cwd === 'string') cwd = r.cwd
      if (human === null && r.type === 'user' && r.isSidechain !== true) {
        const text = extractText(r.message)
        if (text !== null) {
          if (fallback === null) fallback = text
          const h = stripMetaBlocks(text)
          if (h !== '') human = h
        }
      }
      if (cwd !== null && human !== null) break // 提前退出：后面的内容不影响摘要
    }
  } finally {
    rl.close()
    stream.destroy()
  }

  if (human !== null) return { cwd, first_message: human }
  if (fallback === null) return { cwd, first_message: null }
  const inner = fallback.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  return { cwd, first_message: inner !== '' ? inner : fallback }
}

/** path → 上次扫描结果；mtime 没变直接复用。每次列表后整体换新（剔除已删文件）。 */
let scanCache = new Map<string, { mtimeMs: number; scan: ScanResult }>()

export async function listSessions(root: string): Promise<SessionSummary[]> {
  const out: SessionSummary[] = []
  const fresh = new Map<string, { mtimeMs: number; scan: ScanResult }>()
  for (const dir of await readdir(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    const dirPath = join(root, dir.name)
    for (const file of await readdir(dirPath)) {
      if (!file.endsWith('.jsonl')) continue
      const path = join(dirPath, file)
      const s = await stat(path)
      const hit = scanCache.get(path)
      const scan =
        hit !== undefined && hit.mtimeMs === s.mtimeMs ? hit.scan : await scanSessionFile(path)
      fresh.set(path, { mtimeMs: s.mtimeMs, scan })
      out.push({
        session_id: file.slice(0, -'.jsonl'.length),
        project_slug: dir.name,
        cwd: scan.cwd,
        first_message: scan.first_message,
        mtime_ms: s.mtimeMs,
      })
    }
  }
  scanCache = fresh
  // mtime 倒序；打平时按 session_id 排，保证结果确定
  out.sort((a, b) => b.mtime_ms - a.mtime_ms || a.session_id.localeCompare(b.session_id))
  return out
}
