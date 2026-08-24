/**
 * M44：会话全文搜索。侧栏原有过滤只搜标题（首条人话）——
 * 「聊过但记不得在哪个会话」要靠搜正文。
 *
 * 性能策略（列表那套 mtime 缓存对全文不适用，只能扫）：
 * - 文件按 mtime 新→旧排好再扫，拿够 limit 个会话立即停 ——
 *   常见查询（找最近聊过的东西）只扫头部几个文件；
 * - 每行先做廉价的小写子串粗筛，命中才 JSON.parse 精确确认
 *   （base64 图片数据可能被粗筛误中，parse 后只看文本块就排除了）。
 */
import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { join } from 'node:path'

export interface SearchHit {
  session_id: string
  project_slug: string
  cwd: string | null
  /** 首个命中的上下文片段（命中词两侧各 ~40 字符，空白已折叠） */
  snippet: string
  /** 命中的消息行数 */
  match_count: number
  mtime_ms: number
}

const DEFAULT_LIMIT = 20
const SNIPPET_RADIUS = 40

/** message content 里所有 text 块拼成一段（extractText 只取首块，搜索要全量） */
function fullText(message: unknown): string {
  if (typeof message !== 'object' || message === null) return ''
  const content = (message as Record<string, unknown>).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const b = block as Record<string, unknown>
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
  }
  return parts.join('\n')
}

function makeSnippet(text: string, needle: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const at = flat.toLowerCase().indexOf(needle)
  if (at === -1) return flat.slice(0, SNIPPET_RADIUS * 2)
  const start = Math.max(0, at - SNIPPET_RADIUS)
  const end = Math.min(flat.length, at + needle.length + SNIPPET_RADIUS)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}

interface FileMatch {
  cwd: string | null
  snippet: string
  matchCount: number
}

/** 扫一个 jsonl；无命中 → null。粗筛在 raw 行上，确认在消息文本上。 */
async function scanFile(path: string, needle: string): Promise<FileMatch | null> {
  let cwd: string | null = null
  let snippet: string | null = null
  let matchCount = 0

  const stream = createReadStream(path, 'utf8')
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const raw of rl) {
      if (raw === '' || !raw.toLowerCase().includes(needle)) continue
      let row: unknown
      try {
        row = JSON.parse(raw)
      } catch {
        continue
      }
      if (typeof row !== 'object' || row === null) continue
      const r = row as Record<string, unknown>
      if (r.isSidechain === true) continue
      if (r.type !== 'user' && r.type !== 'assistant') continue
      if (cwd === null && typeof r.cwd === 'string') cwd = r.cwd
      const text = fullText(r.message)
      if (!text.toLowerCase().includes(needle)) continue
      matchCount += 1
      if (snippet === null) snippet = makeSnippet(text, needle)
    }
  } finally {
    rl.close()
    stream.destroy()
  }
  return snippet === null ? null : { cwd, snippet, matchCount }
}

export async function searchSessions(
  root: string,
  query: string,
  opts: { limit?: number } = {},
): Promise<SearchHit[]> {
  const needle = query.trim().toLowerCase()
  if (needle === '') return []
  const limit = opts.limit ?? DEFAULT_LIMIT

  // 发现所有主转写（<slug>/<uuid>.jsonl；subagents 子目录天然不在这层）
  const files: { path: string; slug: string; id: string; mtimeMs: number }[] = []
  for (const dir of await readdir(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    const dirPath = join(root, dir.name)
    for (const file of await readdir(dirPath)) {
      if (!file.endsWith('.jsonl')) continue
      const path = join(dirPath, file)
      const s = await stat(path)
      files.push({ path, slug: dir.name, id: file.slice(0, -'.jsonl'.length), mtimeMs: s.mtimeMs })
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs || a.id.localeCompare(b.id))

  const hits: SearchHit[] = []
  for (const f of files) {
    if (hits.length >= limit) break
    const m = await scanFile(f.path, needle)
    if (m === null) continue
    hits.push({
      session_id: f.id,
      project_slug: f.slug,
      cwd: m.cwd,
      snippet: m.snippet,
      match_count: m.matchCount,
      mtime_ms: f.mtimeMs,
    })
  }
  return hits
}
