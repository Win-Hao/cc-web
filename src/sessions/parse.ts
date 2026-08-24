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

/**
 * 主线还原（M51 重写）：**从最新的消息叶子沿 parentUuid 向上走**。
 *
 * 旧算法从根往下贪心选「行号最大的孩子」——真实转写里 ai-title /
 * attachment / last-prompt 等 bookkeeping 行也带 uuid、常挂在老消息下，
 * 一旦被选中就走进死胡同，2900 行的会话只剩 13 行（本机实测）。
 * 向上走天然免疫：起点就是真实对话的末端，死胡同行根本不在路径上。
 *
 * - rewind 分叉：最新叶子属于最新分支 → 旧分支自然不在路径上；
 * - 断链（compact/裁剪导致 parentUuid 指向不存在的行）：一段走完后，
 *   从「更早且未访问」的最新消息行继续向上拼接，不整段丢弃；
 * - attachment 等中继行走链但不输出 —— mainline 只留 user/assistant。
 */
function buildMainline(entries: SessionEntry[]): SessionEntry[] {
  const msgs = entries.filter((e) => e.uuid !== null && !e.isSidechain)
  if (msgs.length === 0) return []
  const byUuid = new Map<string, SessionEntry>()
  for (const e of msgs) byUuid.set(e.uuid!, e)
  const renderable = (e: SessionEntry) => e.type === 'user' || e.type === 'assistant'

  const newestBelow = (line: number, visited: Set<string>): SessionEntry | undefined => {
    let best: SessionEntry | undefined
    for (const e of msgs) {
      if (e.line >= line || visited.has(e.uuid!) || !renderable(e)) continue
      if (best === undefined || e.line > best.line) best = e
    }
    return best
  }

  const visited = new Set<string>()
  const chain: SessionEntry[] = []
  // 种子：最新的 user/assistant 行；整个文件都没有就取最新的任意消息行
  let seed = newestBelow(Number.POSITIVE_INFINITY, visited) ?? msgs[msgs.length - 1]
  while (seed !== undefined) {
    let cur: SessionEntry | undefined = seed
    let top = seed.line
    while (cur !== undefined && !visited.has(cur.uuid!)) {
      visited.add(cur.uuid!)
      chain.push(cur)
      top = cur.line
      cur = cur.parentUuid !== null ? byUuid.get(cur.parentUuid) : undefined
    }
    // 段顶之上还有更早的未访问消息（断链/多纪元）→ 继续拼；
    // 被 rewind 放弃的旧分支行号在段顶之下，不会被拼进来。
    seed = newestBelow(top, visited)
  }
  chain.sort((a, b) => a.line - b.line)
  return chain.filter(renderable)
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
