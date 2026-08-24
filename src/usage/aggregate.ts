/**
 * M2 / D5 降级路径：从 jsonl 聚合会话级 token 用量。
 *
 * 只聚合主线消息（parsed.mainline 已经排除了 rewind 旧分支和 sidechain）。
 * 引擎活着时用量走 get_usage 控制请求（含官方成本）；引擎被回收后降级到这里，
 * 只有 token 量没有成本。两者对前端暴露同一形状（见 docs/ARCHITECTURE.md D5）。
 */
import type { ParsedSession } from '#/sessions/parse.js'

export interface TokenTotals {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  thinking_tokens: number
}

export interface SessionUsage {
  total: TokenTotals
  /** 按 message.model 分组；模型未知的行归入 total 但不进 model_usage */
  model_usage: Record<string, TokenTotals>
}

function zero(): TokenTotals {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    thinking_tokens: 0,
  }
}

function addInto(acc: TokenTotals, u: import('#/sessions/parse.js').MessageUsage): void {
  acc.input_tokens += u.input_tokens ?? 0
  acc.output_tokens += u.output_tokens ?? 0
  acc.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0
  acc.cache_read_input_tokens += u.cache_read_input_tokens ?? 0
  acc.thinking_tokens += u.output_tokens_details?.thinking_tokens ?? 0
}

export function aggregateSessionUsage(parsed: ParsedSession): SessionUsage {
  const total = zero()
  const model_usage: Record<string, TokenTotals> = {}
  for (const e of parsed.mainline) {
    if (e.usage === null) continue
    addInto(total, e.usage)
    if (e.model !== null) addInto((model_usage[e.model] ??= zero()), e.usage)
  }
  return { total, model_usage }
}
