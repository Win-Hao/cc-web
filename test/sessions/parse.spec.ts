/**
 * M2：jsonl 解析 —— 跳过坏行、空文件不抛、parentUuid 还原消息顺序、
 * isSidechain 单独分组（R8）。
 */
import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

describe('buildMainline 的健壮性（M51：真实转写里的丢内容 bug）', () => {
  function write(lines: unknown[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'cc-web-parse-'))
    const p = join(dir, 'dddddddd-0000-0000-0000-000000000004.jsonl')
    writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    return p
  }
  const msg = (type: string, uuid: string, parent: string | null, text = 'x') => ({
    type, uuid, parentUuid: parent, isSidechain: false,
    message: type === 'user' || type === 'assistant' ? { role: type, content: text } : undefined,
  })

  it('挂在老消息下的死胡同 bookkeeping 行不劫持主线（旧贪心算法的 bug）', async () => {
    const p = write([
      msg('user', 'u1', null),
      msg('assistant', 'a1', 'u1'),
      msg('user', 'u2', 'a1'),
      msg('assistant', 'a2', 'u2'),
      // 晚写入、挂在 a1 下、自己没有孩子的 bookkeeping 行 ——
      // 旧算法在 a1 处选「行号最大的孩子」会选中它然后断链
      msg('ai-title', 'title1', 'a1'),
    ])
    const parsed = await parseSessionFile(p)
    expect(parsed.mainline.map((e) => e.uuid)).toEqual(['u1', 'a1', 'u2', 'a2'])
  })

  it('穿过 attachment 等 bookkeeping 中继行：走链但不输出', async () => {
    const p = write([
      msg('user', 'u1', null),
      msg('attachment', 'att1', 'u1'),
      msg('assistant', 'a1', 'att1'),
      msg('user', 'u2', 'a1'),
    ])
    const parsed = await parseSessionFile(p)
    expect(parsed.mainline.map((e) => e.uuid)).toEqual(['u1', 'a1', 'u2'])
  })

  it('断链（parentUuid 指向不存在的行）：更早的段拼接回来，不整段丢弃', async () => {
    const p = write([
      msg('user', 'u1', null),
      msg('assistant', 'a1', 'u1'),
      // compact/裁剪造成 u2 的父链断裂
      msg('user', 'u2', 'missing-uuid'),
      msg('assistant', 'a2', 'u2'),
    ])
    const parsed = await parseSessionFile(p)
    expect(parsed.mainline.map((e) => e.uuid)).toEqual(['u1', 'a1', 'u2', 'a2'])
  })

  it('rewind 分叉语义不回归：被放弃的旧分支仍然不进主线、不被拼接', async () => {
    const p = write([
      msg('user', 'u1', null),
      msg('assistant', 'a1', 'u1'),
      msg('user', 'u2-old', 'a1'),
      msg('assistant', 'a2-old', 'u2-old'),
      // rewind 后的新分支(更晚写入)
      msg('user', 'u2-new', 'a1'),
      msg('assistant', 'a2-new', 'u2-new'),
    ])
    const parsed = await parseSessionFile(p)
    expect(parsed.mainline.map((e) => e.uuid)).toEqual(['u1', 'a1', 'u2-new', 'a2-new'])
  })
})
