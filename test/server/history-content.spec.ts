/**
 * M13：历史消息的 content 块 —— 工具调用渲染的数据源。
 * tool_use / tool_result 透传（形状对齐实时帧），长字符串截断，图片置占位。
 */
import { describe, it, expect } from 'vitest'
import { normalizeMessage } from '#/server/history.js'
import type { SessionEntry } from '#/sessions/parse.js'

function entry(message: unknown, type = 'assistant'): SessionEntry {
  return {
    line: 0, type, uuid: 'u1', parentUuid: null, isSidechain: false,
    timestamp: null, cwd: null, model: null, usage: null, message,
  }
}

describe('normalizeMessage content 块', () => {
  it('tool_use 块透传 name/id/input', () => {
    const m = normalizeMessage(entry({
      role: 'assistant',
      content: [
        { type: 'text', text: '我来跑一下' },
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls -la' } },
      ],
    }))
    expect(m.content).toEqual([
      { type: 'text', text: '我来跑一下' },
      { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls -la' } },
    ])
  })

  it('tool_result 拍平成文本，is_error 保留', () => {
    const m = normalizeMessage(entry({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', is_error: true,
          content: [{ type: 'text', text: 'boom' }] },
      ],
    }, 'user'))
    expect(m.content).toEqual([
      { type: 'tool_result', tool_use_id: 'toolu_1', content: 'boom', is_error: true },
    ])
  })

  it('超长字符串截断（tool 输入可能是整文件）', () => {
    const long = 'x'.repeat(5000)
    const m = normalizeMessage(entry({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't', name: 'Write', input: { content: long } }],
    }))
    const input = (m.content![0] as { input: { content: string } }).input
    expect(input.content.length).toBe(2001) // 2000 + '…'
    expect(input.content.endsWith('…')).toBe(true)
  })

  it('图片块置占位，不透传 base64', () => {
    const m = normalizeMessage(entry({
      role: 'user',
      content: [{ type: 'image', source: { type: 'base64', data: 'AAAA'.repeat(10000) } }],
    }, 'user'))
    expect(m.content).toEqual([{ type: 'text', text: '[图片]' }])
  })

  it('string content / 无 content 的行为不变', () => {
    expect(normalizeMessage(entry({ role: 'user', content: 'hi' }, 'user')).content)
      .toEqual([{ type: 'text', text: 'hi' }])
    expect(normalizeMessage(entry(null, 'summary')).content).toBeNull()
  })
})
