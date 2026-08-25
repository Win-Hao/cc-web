/**
 * D7：实时帧 → Message 事件。LiveTurn 是服务器为「当前回合」持有的有界状态。
 * 输入全部来自录制的真实帧（D4）；每个 fixture 配一份黄金 *.events.json ——
 * 升级 CC 重录后 diff 它，能看到协议变化有没有穿透到浏览器。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { TurnEvent } from '#/engine/index.js'
import { LiveTurn } from '#/server/message/index.js'
import type { Message, MessageEvent, ToolUseBlock } from '#/server/message/index.js'

const RECORDED = fileURLToPath(new URL('../../fixtures/recorded/', import.meta.url))

function frames(name: string): TurnEvent[] {
  return readFileSync(`${RECORDED}${name}.ndjson`, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as TurnEvent)
}

/** 手写的半截帧：归一化层本来就防御性解析，测试不必凑齐 SDK 类型的全部字段 */
const ev = (frame: Record<string, unknown>): TurnEvent => frame as unknown as TurnEvent

/** 固定时钟：每次读取 +250ms，黄金文件才稳定 */
function clock(): () => number {
  let t = 1_700_000_000_000
  return () => (t += 250)
}

function replay(name: string, turn = new LiveTurn(clock())): MessageEvent[] {
  const out: MessageEvent[] = []
  for (const f of frames(name)) out.push(...turn.ingest(f))
  return out
}

const messages = (evs: MessageEvent[]): Message[] =>
  evs.filter((e): e is Extract<MessageEvent, { event: 'message' }> => e.event === 'message').map((e) => e.data)

describe('LiveTurn：录制回放', () => {
  it('simple-turn：占位 → delta → 最终消息 replaces 占位 → turn_end', () => {
    const evs = replay('simple-turn')
    const kinds = evs.map((e) => e.event)
    expect(kinds[0]).toBe('init')
    // 占位先于 delta，delta 落在占位的 key 上
    const ph = evs.findIndex((e) => e.event === 'message' && e.data.partial && e.data.role === 'assistant')
    const firstDelta = evs.findIndex((e) => e.event === 'delta')
    expect(ph).toBeGreaterThan(-1)
    expect(firstDelta).toBeGreaterThan(ph)
    const phKey = (evs[ph] as { data: Message }).data.key
    expect((evs[firstDelta] as { data: { key: string; kind: string } }).data).toMatchObject({ key: phKey, kind: 'text' })
    // 最终消息带 uuid，replaces 占位
    const final = messages(evs).find((m) => m.role === 'assistant' && !m.partial)!
    expect(final.uuid).not.toBeNull()
    expect(final.key).toBe(final.uuid)
    expect(final.replaces).toBe(phKey)
    expect(final.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('hi') })
    // 回显的 user 帧成为 user 消息（真实 uuid）
    const user = messages(evs).find((m) => m.role === 'user')!
    expect(user.uuid).not.toBeNull()
    expect(user.text).toBe('Reply with exactly: hi')
    // 收尾
    expect(kinds[kinds.length - 1]).toBe('turn_end')
    expect(kinds).toContain('rate_limit')
    expect(kinds).not.toContain('raw')
  })

  it('tool-turn：tool_use 占位随 input_json_delta 更新 input；tool_result 让 status 变 ok；收尾文本另起一条', () => {
    const evs = replay('tool-turn')
    const msgs = messages(evs)
    // 占位阶段：input 从 {} 长成完整对象（半截 JSON 也尽量解析）
    const phases = msgs.filter((m) => m.partial && m.content[0]?.type === 'tool_use').map((m) => (m.content[0] as ToolUseBlock).input)
    expect(phases[0]).toEqual({})
    expect(phases.some((p) => typeof (p as { file_path?: string }).file_path === 'string' && !(p as { file_path: string }).file_path.endsWith('hello.txt'))).toBe(true)
    expect(phases[phases.length - 1]).toMatchObject({ file_path: expect.stringMatching(/hello\.txt$/) })
    // 最终 tool_use 消息：先 pending，tool_result 到了同一 key 再发一次变 ok
    const toolMsgs = msgs.filter((m) => !m.partial && m.content[0]?.type === 'tool_use')
    expect(toolMsgs.length).toBe(2)
    expect(toolMsgs[0]!.key).toBe(toolMsgs[1]!.key)
    expect((toolMsgs[0]!.content[0] as ToolUseBlock).status).toBe('pending')
    expect(toolMsgs[1]!.content[0]).toMatchObject({ status: 'ok', result: expect.stringContaining('cc-web probe says hello') })
    // tool_result 行本身不出消息
    expect(msgs.some((m) => m.role === 'user' && m.text === null)).toBe(false)
    // 有 thinking 块的话（模型这次不一定思考），seconds 由服务器计
    const thinking = msgs.find((m) => !m.partial && m.content[0]?.type === 'thinking')
    if (thinking !== undefined) expect(thinking.content[0]).toMatchObject({ type: 'thinking', seconds: expect.any(Number) })
    // 收尾文本是新的 message.id，另起一条
    const finalText = msgs.filter((m) => !m.partial && m.role === 'assistant' && m.content[0]?.type === 'text')
    expect(finalText).toHaveLength(1)
    expect(finalText[0]!.text).toContain('cc-web probe says hello')
    // turn_end 带统计
    const end = evs[evs.length - 1]!
    expect(end.event).toBe('turn_end')
    expect((end as { data: { duration_ms: number | null } }).data.duration_ms).toEqual(expect.any(Number))
  })

  it('黄金文件：normalizer 的输出随 fixture 入库，升级 CC 后 diff 它', async () => {
    for (const name of ['simple-turn', 'tool-turn']) {
      const evs = replay(name)
      await expect(JSON.stringify(evs, null, 2) + '\n').toMatchFileSnapshot(`${RECORDED}${name}.events.json`)
    }
  })

  it('prompt 占位：回显的 user 帧（isReplay）替换它', () => {
    const turn = new LiveTurn(clock())
    const ph = turn.prompt('Reply with exactly: hi', [])
    expect(ph).toMatchObject({ key: 'prompt:1', role: 'user', partial: true, text: 'Reply with exactly: hi' })
    expect(turn.snapshot().map((m) => m.key)).toEqual(['prompt:1'])
    const evs = replay('simple-turn', turn)
    const user = messages(evs).find((m) => m.role === 'user')!
    expect(user.replaces).toBe('prompt:1')
    expect(user.partial).toBe(false)
  })

  it('init 帧 → init 事件（model / permission_mode）', () => {
    const init = replay('simple-turn').find((e) => e.event === 'init') as { data: { model: string | null; permission_mode: string | null } }
    expect(init.data.model).toEqual(expect.any(String))
    expect(init.data.permission_mode).toEqual(expect.any(String))
  })
})

describe('LiveTurn：回合结束与异常', () => {
  /** tool-turn 喂到「tool_use 最终帧」为止（tool_result 还没来） */
  function feedUntilToolUse(turn: LiveTurn): MessageEvent[] {
    const out: MessageEvent[] = []
    for (const f of frames('tool-turn')) {
      out.push(...turn.ingest(f))
      const fr = f as { type?: string; message?: { content?: { type?: string }[] } }
      if (fr.type === 'assistant' && fr.message?.content?.[0]?.type === 'tool_use') break
    }
    return out
  }

  it('abort（引擎退出）：未完成的 tool_use → canceled，占位转终态，turn_end 统计为 null，状态清空', () => {
    const turn = new LiveTurn(clock())
    feedUntilToolUse(turn)
    expect(turn.openToolUseIds().size).toBe(1)
    const evs = turn.abort()
    const canceled = messages(evs).find((m) => m.content[0]?.type === 'tool_use')!
    expect((canceled.content[0] as ToolUseBlock).status).toBe('canceled')
    expect(evs[evs.length - 1]).toEqual({ event: 'turn_end', data: { duration_ms: null, output_tokens: null, cost_usd: null } })
    expect(turn.snapshot()).toEqual([])
    expect(turn.openToolUseIds().size).toBe(0)
  })

  it('result 到达时还没结果的 tool_use → canceled（中断）', () => {
    const turn = new LiveTurn(clock())
    feedUntilToolUse(turn)
    const evs = turn.ingest(ev({ type: 'result', subtype: 'error_during_execution', duration_ms: 1234, total_cost_usd: 0.01, usage: { output_tokens: 7 } }))
    expect((messages(evs)[0]!.content[0] as ToolUseBlock).status).toBe('canceled')
    expect(evs[evs.length - 1]).toEqual({ event: 'turn_end', data: { duration_ms: 1234, output_tokens: 7, cost_usd: 0.01 } })
  })

  it('subagent 帧（parent_tool_use_id）不进主流，只给对应 tool_use 计 sub_count', () => {
    const turn = new LiveTurn(clock())
    const before = feedUntilToolUse(turn)
    const toolKey = messages(before).filter((m) => !m.partial && m.content[0]?.type === 'tool_use')[0]!.key
    const toolId = (messages(before).find((m) => m.key === toolKey)!.content[0] as ToolUseBlock).id!
    const sub = (type: string) => ev({
      type, parent_tool_use_id: toolId, uuid: `sub-${type}`, session_id: 's',
      message: { role: type, content: [{ type: 'text', text: 'sub' }] },
    })
    const evs = [
      ...turn.ingest(sub('assistant')),
      ...turn.ingest(ev({ type: 'stream_event', parent_tool_use_id: toolId, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } } })),
      ...turn.ingest(sub('user')),
    ]
    expect(evs.every((e) => e.event === 'message' && e.data.key === toolKey)).toBe(true)
    expect(evs).toHaveLength(2) // stream_event 不计数
    expect((messages(evs)[1]!.content[0] as ToolUseBlock).sub_count).toBe(2)
  })

  it('snapshot 只含当前回合的消息（占位带已累积文本），result 之后清空', () => {
    const turn = new LiveTurn(clock())
    const all = frames('simple-turn')
    const cut = all.findIndex((f) => (f as { type?: string }).type === 'assistant')
    for (const f of all.slice(0, cut)) turn.ingest(f)
    const snap = turn.snapshot()
    const ph = snap.find((m) => m.role === 'assistant')!
    expect(ph.partial).toBe(true)
    expect((ph.content[0] as { text: string }).text.length).toBeGreaterThan(0) // delta 已累积进占位
    for (const f of all.slice(cut)) turn.ingest(f)
    expect(turn.snapshot()).toEqual([])
  })

  it('thinking 块的秒数由服务器计（块开始 → 最终帧）', () => {
    // 帧形状来自 2.1.243 的一次录制（tool-turn 首次录制时模型有思考；重录后没有）：
    // content_block_start(thinking) → thinking_delta → signature_delta → assistant{thinking, signature}
    let t = 1_000
    const turn = new LiveTurn(() => (t += 2_000))
    const evs = [
      ...turn.ingest(ev({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'msg_t', model: 'm', role: 'assistant', content: [] } } })),
      ...turn.ingest(ev({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } } })),
      ...turn.ingest(ev({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '先看' } } })),
      ...turn.ingest(ev({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } } })),
      ...turn.ingest(ev({ type: 'assistant', parent_tool_use_id: null, uuid: 'u-think', timestamp: 't', message: { id: 'msg_t', model: 'm', role: 'assistant', content: [{ type: 'thinking', thinking: '先看', signature: 'sig' }] } })),
    ]
    expect(evs.map((e) => e.event)).toEqual(['message', 'delta', 'message'])
    const final = messages(evs)[1]!
    expect(final).toMatchObject({ key: 'u-think', replaces: 'msg_t:0', partial: false })
    // 时钟每读一次 +2s：块开始读一次（startedAt），最终帧读一次 → 2s
    expect(final.content[0]).toMatchObject({ type: 'thinking', thinking: '先看', seconds: 2 })
  })

  it('发出去的事件是快照，之后的状态变化不会改写已发事件', () => {
    const turn = new LiveTurn(clock())
    const evs = replay('simple-turn', turn)
    const ph = messages(evs).find((m) => m.partial && m.role === 'assistant')!
    expect((ph.content[0] as { text: string }).text).toBe('')
  })
})
