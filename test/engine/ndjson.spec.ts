/**
 * M1：NDJSON 解析。
 *
 * 粘包和坏 JSON 是 NDJSON 解析器 100% 会在生产遇到的两种情况（TDD M1），
 * 都在这里有测试钉住。
 */
import { describe, it, expect, vi } from 'vitest'
import { NdjsonParser } from '#/engine/ndjson.js'

function makeParser() {
  const messages: unknown[] = []
  const errors: { err: Error; raw: string }[] = []
  const parser = new NdjsonParser({
    onMessage: (m) => messages.push(m),
    onError: (err, raw) => errors.push({ err, raw }),
  })
  return { parser, messages, errors }
}

describe('NdjsonParser', () => {
  it('完整的一行 → 一个事件', () => {
    const { parser, messages } = makeParser()
    parser.push('{"type":"system","subtype":"init"}\n')
    expect(messages).toEqual([{ type: 'system', subtype: 'init' }])
  })

  it('一行被拆成两个 chunk → 仍然只出一个事件（粘包）', () => {
    const { parser, messages } = makeParser()
    const line = '{"type":"assistant","text":"hello"}'
    const at = Math.floor(line.length / 2)
    parser.push(line.slice(0, at))
    expect(messages).toHaveLength(0) // 没到 \n 不能出事件
    parser.push(line.slice(at) + '\n')
    expect(messages).toEqual([{ type: 'assistant', text: 'hello' }])
  })

  it('一个 chunk 里有多行 → 出多个事件', () => {
    const { parser, messages } = makeParser()
    parser.push('{"a":1}\n{"b":2}\n{"c":3}\n')
    expect(messages).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }])
  })

  it('空行跳过', () => {
    const { parser, messages, errors } = makeParser()
    parser.push('\n{"a":1}\n\n\n')
    expect(messages).toEqual([{ a: 1 }])
    expect(errors).toHaveLength(0)
  })

  it('坏 JSON 不炸解析器，onError 报出后继续读下一行', () => {
    const { parser, messages, errors } = makeParser()
    parser.push('{oops\n{"ok":true}\n')
    expect(errors).toHaveLength(1)
    expect(errors[0]!.raw).toBe('{oops')
    expect(messages).toEqual([{ ok: true }])
  })

  it('end() 把没有换行结尾的残 buffer 也当一帧交出来', () => {
    const { parser, messages } = makeParser()
    parser.push('{"tail":1}')
    parser.end()
    expect(messages).toEqual([{ tail: 1 }])
  })
})
