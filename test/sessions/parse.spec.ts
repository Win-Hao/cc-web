/**
 * M2：jsonl 解析 —— 跳过坏行、空文件不抛、parentUuid 还原消息顺序、
 * isSidechain 单独分组（R8）。
 */
import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { parseSessionFile } from '#/sessions/parse.js'

const FIXTURES = fileURLToPath(new URL('../fixtures/sessions', import.meta.url))
const SESSION_A = `${FIXTURES}/-Users-x-proj-a/aaaaaaaa-0000-0000-0000-000000000001.jsonl`
const SESSION_B = `${FIXTURES}/-Users-x-proj-b/bbbbbbbb-0000-0000-0000-000000000002.jsonl`
const SESSION_C = `${FIXTURES}/-Users-x-proj-c/cccccccc-0000-0000-0000-000000000003.jsonl`

describe('parseSessionFile', () => {
  it('逐行解析，跳过坏行（含截断行），空行不算坏行', async () => {
    const parsed = await parseSessionFile(SESSION_C)
    // 8 条树消息 + 1 条 last-prompt  bookkeeping = 9 条有效行
    expect(parsed.entries).toHaveLength(9)
    expect(parsed.skippedLines).toBe(2)
  })

  it('空文件返回空数组，不抛', async () => {
    const parsed = await parseSessionFile(SESSION_B)
    expect(parsed.entries).toEqual([])
    expect(parsed.mainline).toEqual([])
    expect(parsed.sidechains).toEqual({})
    expect(parsed.skippedLines).toBe(0)
  })

  it('parentUuid 能还原消息顺序（线性链）', async () => {
    const parsed = await parseSessionFile(SESSION_A)
    expect(parsed.mainline.map((e) => e.uuid)).toEqual([
      'a-u1',
      'a-a1',
      'a-u2',
      'a-a2',
      'a-u3',
      'a-a3',
    ])
  })

  it('rewind 造成的分叉：最新分支赢，旧分支不进主线', async () => {
    const parsed = await parseSessionFile(SESSION_C)
    // c-u2/c-a2 是被 rewind 掉的旧分支；当前分支是 c-u3/c-a3
    expect(parsed.mainline.map((e) => e.uuid)).toEqual([
      'c-u1',
      'c-a1',
      'c-u3',
      'c-a3',
    ])
  })

  it('isSidechain: true 的消息不进主线，按父消息单独分组', async () => {
    const parsed = await parseSessionFile(SESSION_C)
    expect(parsed.mainline.some((e) => e.isSidechain)).toBe(false)
    expect(Object.keys(parsed.sidechains)).toEqual(['c-a3'])
    expect(parsed.sidechains['c-a3']!.map((e) => e.uuid)).toEqual(['c-s1', 'c-s2'])
  })

  it('解析出行号、usage、model、cwd 等分页/聚合/恢复需要的字段', async () => {
    const parsed = await parseSessionFile(SESSION_A)
    const a1 = parsed.entries.find((e) => e.uuid === 'a-a1')!
    expect(a1.line).toBe(2)
    expect(a1.model).toBe('claude-opus-5')
    expect(a1.usage?.input_tokens).toBe(10)
    expect(a1.usage?.output_tokens_details?.thinking_tokens).toBe(5)
    expect(a1.cwd).toBe('/Users/x/proj-a')
    expect(a1.parentUuid).toBe('a-u1')
  })

  it('没有 uuid 的 bookkeeping 行不进消息树', async () => {
    const parsed = await parseSessionFile(SESSION_A)
    // entries 里有 mode 行，但 mainline 里没有
    expect(parsed.entries.some((e) => e.type === 'mode')).toBe(true)
    expect(parsed.mainline.every((e) => typeof e.uuid === 'string')).toBe(true)
  })
})
