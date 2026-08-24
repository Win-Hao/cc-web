/**
 * M2：解析 ~/.claude/projects/<slug>/<uuid>.jsonl。
 *
 * jsonl 是 append-only 的落盘记录（PROTOCOL §2），所以「行号越大越新」
 * 是可靠的时序依据——rewind 造成的分叉取行号大的分支，不用信 timestamp。
 *
 * 坏行（截断、非 JSON）跳过并计数；空行静默跳过，不算坏行。
 */
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

/** message.usage 的形状（实测样本见 PROTOCOL §2）。上游会加字段，所以放开索引。 */
export interface MessageUsage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  output_tokens_details?: { thinking_tokens?: number }
  [k: string]: unknown
}

export interface SessionEntry {
  /** 0-based 文件行号（坏行/空行也占号，保证和文件位置对应） */
  line: number
  type: string | null
  uuid: string | null
  parentUuid: string | null
  isSidechain: boolean
  timestamp: string | null
  cwd: string | null
  /** assistant 行的 message.model；其它行为 null */
  model: string | null
  /** assistant 行的 message.usage；其它行为 null */
  usage: MessageUsage | null
  /** 原始 message 字段（user/assistant 行才有），bookkeeping 行为 null */
  message: unknown
}

export interface ParsedSession {
  /** 全部有效行（含 mode / last-prompt 等 bookkeeping），按行号升序 */
  entries: SessionEntry[]
  /** 主线消息链：parentUuid 还原，rewind 分叉取最新分支，sidechain 不进 */
  mainline: SessionEntry[]
  /** subagent 消息，按它锚定的主线消息 uuid 分组（R8） */
  sidechains: Record<string, SessionEntry[]>
  /** 跳过的坏行数 */
  skippedLines: number
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

function toEntry(line: number, row: Record<string, unknown>): SessionEntry {
  const message =
    typeof row.message === 'object' && row.message !== null
      ? (row.message as Record<string, unknown>)
      : null
  const usage =
    message !== null && typeof message.usage === 'object' && message.usage !== null
      ? (message.usage as MessageUsage)
      : null
  return {
    line,
    type: str(row.type),
    uuid: str(row.uuid),
    parentUuid: str(row.parentUuid),
    isSidechain: row.isSidechain === true,
    timestamp: str(row.timestamp),
    cwd: str(row.cwd),
    model: message !== null ? str(message.model) : null,
    usage,
    message: row.message ?? null,
  }
}

/** 非 sidechain 消息沿 parentUuid 走链；每个节点有多个孩子时取行号最大的（最新分支赢）。 */
function buildMainline(entries: SessionEntry[]): SessionEntry[] {
  const msgs = entries.filter((e) => e.uuid !== null && !e.isSidechain)
  const childrenOf = new Map<string, SessionEntry[]>()
  const roots: SessionEntry[] = []
  for (const e of msgs) {
    if (e.parentUuid === null) {
      roots.push(e)
    } else {
      const kids = childrenOf.get(e.parentUuid)
      if (kids) kids.push(e)
      else childrenOf.set(e.parentUuid, [e])
    }
  }
  const newest = (list: SessionEntry[]) =>
    list.reduce((a, b) => (b.line > a.line ? b : a))

  const chain: SessionEntry[] = []
  const seen = new Set<string>()
  let cur: SessionEntry | null = roots.length > 0 ? newest(roots) : null
  while (cur !== null && !seen.has(cur.uuid!)) {
    seen.add(cur.uuid!)
    chain.push(cur)
    const kids = childrenOf.get(cur.uuid!)
    cur = kids && kids.length > 0 ? newest(kids) : null
  }
  return chain
}

/**
 * sidechain 消息按「锚点」分组：沿 parentUuid 向上走到第一条非 sidechain
 * 消息，那个 uuid 就是 key（例：subagent 从主线的 c-a3 分叉 → 归到 'c-a3'）。
 * 锚不到任何消息的孤儿不进组（仍在 entries 里）。
 */
function buildSidechains(entries: SessionEntry[]): Record<string, SessionEntry[]> {
  const byUuid = new Map<string, SessionEntry>()
  for (const e of entries) if (e.uuid !== null) byUuid.set(e.uuid, e)

  const groups: Record<string, SessionEntry[]> = {}
  for (const e of entries) {
    if (!e.isSidechain || e.uuid === null) continue
    const seen = new Set<string>([e.uuid])
    let anchor = e.parentUuid
    while (anchor !== null) {
      const parent = byUuid.get(anchor)
      if (parent === undefined || !parent.isSidechain) break
      if (seen.has(parent.uuid!)) {
        anchor = null
        break
      }
      seen.add(parent.uuid!)
      anchor = parent.parentUuid
    }
    if (anchor === null) continue
    ;(groups[anchor] ??= []).push(e)
  }
  for (const list of Object.values(groups)) list.sort((a, b) => a.line - b.line)
  return groups
}

export async function parseSessionFile(path: string): Promise<ParsedSession> {
  const entries: SessionEntry[] = []
  let skippedLines = 0
  let line = -1

  const rl = createInterface({
    input: createReadStream(path, 'utf8'),
    crlfDelay: Infinity,
  })
  for await (const raw of rl) {
    line++
    if (raw.trim() === '') continue
    let row: unknown
    try {
      row = JSON.parse(raw)
    } catch {
      skippedLines++
      continue
    }
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      skippedLines++
      continue
    }
    entries.push(toEntry(line, row as Record<string, unknown>))
  }

  return {
    entries,
    mainline: buildMainline(entries),
    sidechains: buildSidechains(entries),
    skippedLines,
  }
}
