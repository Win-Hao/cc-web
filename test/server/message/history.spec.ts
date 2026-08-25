/**
 * D7：历史（jsonl 行）→ Message 的归一化。interface 是 mainline 级的：
 * tool_result 在这里配对进 tool_use，sidechain / subagent 在这里挂上，
 * 浏览器拿到的就是能直接渲染的形状。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { normalizeHistory, paginate } from '#/server/message/index.js'
import type { Message, ToolUseBlock } from '#/server/message/index.js'
import type { SessionEntry } from '#/sessions/parse.js'

let line = 0
beforeEach(() => {
  line = 0
})

function entry(
  message: unknown,
  opts: { type?: string; uuid?: string | null; model?: string | null; timestamp?: string | null } = {},
): SessionEntry {
  const l = line++
  return {
    line: l,
    type: opts.type ?? (typeof message === 'object' && message !== null ? String((message as { role?: string }).role) : 'summary'),
    uuid: opts.uuid === undefined ? `u${l}` : opts.uuid,
    parentUuid: null,
    isSidechain: false,
    timestamp: opts.timestamp ?? null,
    cwd: null,
    model: opts.model ?? null,
    usage: null,
    message,
  }
}

const tool = (m: Message, i = 0): ToolUseBlock => m.content[i] as ToolUseBlock

describe('normalizeHistory：块归一化', () => {
  it('assistant 的 text / tool_use 变成块，tool_use 初始 pending、带 status/result/images/sub_count/agent', () => {
    const [m] = normalizeHistory([
      entry({
        role: 'assistant',
        content: [
          { type: 'text', text: '我来跑一下' },
          { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls -la' } },
        ],
      }),
    ])
    expect(m).toMatchObject({ key: 'u0', uuid: 'u0', cursor: 0, role: 'assistant', text: '我来跑一下', partial: false })
    expect(m!.content).toEqual([
      { type: 'text', text: '我来跑一下' },
      {
        type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls -la' },
        status: 'canceled', result: null, images: [], sub_count: 0, agent: null,
      },
    ])
  })

  it('超长字符串截断（tool 输入可能是整文件）', () => {
    const long = 'x'.repeat(5000)
    const [m] = normalizeHistory([
      entry({ role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Write', input: { content: long } }] }),
    ])
    const input = tool(m!).input as { content: string }
    expect(input.content.length).toBe(2001) // 2000 + '…'
    expect(input.content.endsWith('…')).toBe(true)
  })

  it('图片块 → {type: image, media_type, data}；超大图（>2MB base64）降级为占位文本', () => {
    const [ok, big] = normalizeHistory([
      entry({ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA'.repeat(100) } }] }),
      entry({ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(3_000_000) } }] }),
    ])
    expect(ok!.content).toEqual([{ type: 'image', media_type: 'image/png', data: 'AAAA'.repeat(100) }])
    expect(big!.content).toEqual([{ type: 'text', text: '[图片]' }])
  })

  it('thinking 块去掉 signature', () => {
    const [m] = normalizeHistory([
      entry({ role: 'assistant', content: [{ type: 'thinking', thinking: '先看下文件结构', signature: 'sig' }, { type: 'text', text: '好的' }] }),
    ])
    expect(m!.content).toEqual([{ type: 'thinking', thinking: '先看下文件结构' }, { type: 'text', text: '好的' }])
  })

  it('string content → 一个 text 块；bookkeeping 行（message 为 null）不出消息', () => {
    const out = normalizeHistory([entry({ role: 'user', content: 'hi' }), entry(null, { type: 'summary' })])
    expect(out).toHaveLength(1)
    expect(out[0]!.content).toEqual([{ type: 'text', text: 'hi' }])
  })

  it('model / timestamp 从行上带过来', () => {
    const [m] = normalizeHistory([
      entry({ role: 'assistant', content: [{ type: 'text', text: 'x' }] }, { model: 'claude-fable-5', timestamp: '2026-08-25T00:00:00Z' }),
    ])
    expect(m).toMatchObject({ model: 'claude-fable-5', timestamp: '2026-08-25T00:00:00Z' })
  })
})

describe('normalizeHistory：tool_result 配对', () => {
  it('tool_result 折进 tool_use（status ok + result 文本），tool_result 行本身不出消息', () => {
    const out = normalizeHistory([
      entry({ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] }),
      entry({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'done' }] }] }),
    ])
    expect(out).toHaveLength(1)
    expect(tool(out[0]!)).toMatchObject({ status: 'ok', result: 'done' })
  })

  it('is_error → status error', () => {
    const out = normalizeHistory([
      entry({ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] }),
      entry({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'boom' }] }),
    ])
    expect(tool(out[0]!)).toMatchObject({ status: 'error', result: 'boom' })
  })

  it('tool_result 里的图片抽到 tool_use.images（截图类工具）', () => {
    const out = normalizeHistory([
      entry({ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Screenshot', input: {} }] }),
      entry({
        role: 'user',
        content: [{
          type: 'tool_result', tool_use_id: 't1',
          content: [{ type: 'text', text: '截图完成' }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBBB' } }],
        }],
      }),
    ])
    expect(tool(out[0]!)).toMatchObject({ status: 'ok', result: '截图完成', images: [{ media_type: 'image/jpeg', data: 'BBBB' }] })
  })

  it('没有结果的 tool_use → canceled；在 openToolUseIds 里的（当前回合还在跑）→ pending', () => {
    const rows = [
      entry({ role: 'assistant', content: [{ type: 'tool_use', id: 'old', name: 'Bash', input: {} }] }),
      entry({ role: 'assistant', content: [{ type: 'tool_use', id: 'live', name: 'Bash', input: {} }] }),
    ]
    const plain = normalizeHistory(rows)
    expect(plain.map((m) => tool(m).status)).toEqual(['canceled', 'canceled'])
    line = 0
    const withOpen = normalizeHistory(rows, { openToolUseIds: new Set(['live']) })
    expect(withOpen.map((m) => tool(m).status)).toEqual(['canceled', 'pending'])
  })

  it('tool_result 行里混着文本块 → 文本块单独成 user 消息', () => {
    const out = normalizeHistory([
      entry({ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] }),
      entry({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }, { type: 'text', text: '顺便问一句' }] }),
    ])
    expect(out).toHaveLength(2)
    expect(out[1]).toMatchObject({ role: 'user', text: '顺便问一句' })
  })
})

describe('normalizeHistory：user 文本与 meta 标签', () => {
  it('user 文本剥掉打头的 meta 标签；剥空的消息不出', () => {
    const out = normalizeHistory([
      entry({ role: 'user', content: '<local-command-caveat>x</local-command-caveat>\n你好' }),
      entry({ role: 'user', content: [{ type: 'text', text: '<command-name>/clear</command-name>' }] }),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ text: '你好', content: [{ type: 'text', text: '你好' }] })
  })

  it('assistant 文本不剥（模型自己写的尖括号是内容）', () => {
    const [m] = normalizeHistory([entry({ role: 'assistant', content: [{ type: 'text', text: '<b>粗体</b>' }] })])
    expect(m!.text).toBe('<b>粗体</b>')
  })
})

describe('normalizeHistory：sidechain / subagent 标注', () => {
  it('锚点消息带 sidechain_count，其它消息不带', () => {
    const a1 = entry({ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Task', input: {} }] }, { uuid: 'a1' })
    const a2 = entry({ role: 'assistant', content: [{ type: 'text', text: '查完了' }] }, { uuid: 'a2' })
    const out = normalizeHistory([a1, a2], {
      sidechains: { a1: [entry({ role: 'user', content: '子' }), entry({ role: 'assistant', content: [{ type: 'text', text: '果' }] })] },
    })
    expect(out[0]!.sidechain_count).toBe(2)
    expect(out[1]!.sidechain_count).toBeUndefined()
  })

  it('subagents 的 tool_use_id 命中 → tool_use.agent = {id, label}', () => {
    const out = normalizeHistory(
      [entry({ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Task', input: {} }] })],
      { subagents: [{ agent_id: 'abc', tool_use_id: 't1', agent_type: 'Explore', description: '找配置文件' }] },
    )
    expect(tool(out[0]!).agent).toEqual({ id: 'abc', label: '找配置文件' })
  })
})

describe('paginate', () => {
  it('cursor = 行号；before 取更早一页；has_more 表示前面还有', () => {
    const msgs = normalizeHistory([
      entry({ role: 'user', content: 'a' }),
      entry({ role: 'assistant', content: [{ type: 'text', text: 'b' }] }),
      entry({ role: 'user', content: 'c' }),
    ])
    const last = paginate(msgs, { limit: 2 })
    expect(last.messages.map((m) => m.cursor)).toEqual([1, 2])
    expect(last.has_more).toBe(true)
    const older = paginate(msgs, { limit: 2, before: 1 })
    expect(older.messages.map((m) => m.cursor)).toEqual([0])
    expect(older.has_more).toBe(false)
  })

  it('被吞掉的 tool_result 行不占页位，剩下消息的 cursor 仍是原行号', () => {
    const msgs = normalizeHistory([
      entry({ role: 'user', content: 'a' }),
      entry({ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] }),
      entry({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }),
      entry({ role: 'assistant', content: [{ type: 'text', text: 'done' }] }),
    ])
    expect(msgs.map((m) => m.cursor)).toEqual([0, 1, 3])
    expect(paginate(msgs, { limit: 2 }).messages.map((m) => m.cursor)).toEqual([1, 3])
  })
})
