/**
 * M2：扫描 projects 根目录（~/.claude/projects），列出所有会话，按 mtime 倒序。
 *
 * 每个会话的 cwd / 首条用户消息从 jsonl 内容里读（slug 不可逆，见 slug.ts
 * 注释）。空文件没有可读信息，对应字段给 null，不猜。
 */
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { parseSessionFile } from './parse.js'
import { extractText } from './text.js'
import type { ParsedSession, SessionEntry } from './parse.js'

export interface SessionSummary {
  /** 文件名去掉 .jsonl，即 session uuid */
  session_id: string
  project_slug: string
  /** 从 jsonl 行的 cwd 字段读；读不到（空文件）为 null */
  cwd: string | null
  /** 主线首条可提取文本的用户消息；没有为 null */
  first_message: string | null
  mtime_ms: number
}

function firstCwd(entries: SessionEntry[]): string | null {
  for (const e of entries) if (e.cwd !== null) return e.cwd
  return null
}

/**
 * 剥掉打头的成对元信息块：CC 会往 user 消息前面注入
 * <local-command-caveat> / <ide_opened_file> / <command-name> … 这类
 * XML 风格标签，人话（如果有）跟在后面。剥不干净（未闭合/剥完还是
 * '<' 开头）→ ''，调用方跳过这条。
 */
function stripMetaBlocks(text: string): string {
  let t = text.trimStart()
  while (t.startsWith('<')) {
    const m = /^<([a-zA-Z][\w-]*)[^>]*>/.exec(t)
    if (m === null) return ''
    const close = `</${m[1]}>`
    const end = t.indexOf(close)
    if (end === -1) return ''
    t = t.slice(end + close.length).trimStart()
  }
  return t
}

/**
 * 主线首条「像人打的」用户消息当标题：剥掉元信息块后还有内容的才算。
 * 整个会话全是元信息（例：IDE 自动注入的 <ide_opened_file>，用户没打过字）
 * 就退回第一条的标签内文本 —— 去掉尖括号本身，内容还是有信息量的。
 */
function firstUserMessage(parsed: ParsedSession): string | null {
  let fallback: string | null = null
  for (const e of parsed.mainline) {
    if (e.type !== 'user') continue
    const text = extractText(e.message)
    if (text === null) continue
    if (fallback === null) fallback = text
    const human = stripMetaBlocks(text)
    if (human !== '') return human
  }
  if (fallback === null) return null
  const inner = fallback.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  return inner !== '' ? inner : fallback
}

export async function listSessions(root: string): Promise<SessionSummary[]> {
  const out: SessionSummary[] = []
  for (const dir of await readdir(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    const dirPath = join(root, dir.name)
    for (const file of await readdir(dirPath)) {
      if (!file.endsWith('.jsonl')) continue
      const path = join(dirPath, file)
      const [s, parsed] = await Promise.all([stat(path), parseSessionFile(path)])
      out.push({
        session_id: file.slice(0, -'.jsonl'.length),
        project_slug: dir.name,
        cwd: firstCwd(parsed.entries),
        first_message: firstUserMessage(parsed),
        mtime_ms: s.mtimeMs,
      })
    }
  }
  // mtime 倒序；打平时按 session_id 排，保证结果确定
  out.sort((a, b) => b.mtime_ms - a.mtime_ms || a.session_id.localeCompare(b.session_id))
  return out
}
