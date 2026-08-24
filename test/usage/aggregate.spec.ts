/**
 * M2：从 message.usage 聚合本会话 token 总量。
 *
 * 只聚合主线：rewind 掉的旧分支不进主线所以自然不计；
 * sidechain（subagent）单独分组，也不进主线总量（TDD M2：
 * 「isSidechain 不计入主线（或单独计，二选一）」——这里选不计入）。
 */
import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { parseSessionFile } from '#/sessions/parse.js'
import { aggregateSessionUsage } from '#/usage/aggregate.js'

const FIXTURES = fileURLToPath(new URL('../fixtures/sessions', import.meta.url))
const SESSION_A = `${FIXTURES}/-Users-x-proj-a/aaaaaaaa-0000-0000-0000-000000000001.jsonl`
const SESSION_B = `${FIXTURES}/-Users-x-proj-b/bbbbbbbb-0000-0000-0000-000000000002.jsonl`
const SESSION_C = `${FIXTURES}/-Users-x-proj-c/cccccccc-0000-0000-0000-000000000003.jsonl`

describe('aggregateSessionUsage', () => {
  it('聚合主线总量，区分 input / output / cache_creation / cache_read / thinking', async () => {
    const parsed = await parseSessionFile(SESSION_A)
    const usage = aggregateSessionUsage(parsed)
    expect(usage.total).toEqual({
      input_tokens: 14,
      output_tokens: 26,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 250,
      thinking_tokens: 6,
    })
  })

  it('按模型分 model_usage（缺省维度补 0，前端不用判空）', async () => {
    const parsed = await parseSessionFile(SESSION_A)
    const usage = aggregateSessionUsage(parsed)
    expect(usage.model_usage['claude-opus-5']).toEqual({
      input_tokens: 11,
      output_tokens: 22,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 250,
      thinking_tokens: 5,
    })
    expect(usage.model_usage['claude-sonnet-5']).toEqual({
      input_tokens: 3,
      output_tokens: 4,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      thinking_tokens: 1,
    })
  })

  it('rewind 掉的旧分支和 sidechain 都不计入', async () => {
    const parsed = await parseSessionFile(SESSION_C)
    const usage = aggregateSessionUsage(parsed)
    // 主线只剩 c-a1 + c-a3；旧分支 c-a2（100/100）和 sidechain c-s2（7/8）都不算
    expect(usage.total).toEqual({
      input_tokens: 6,
      output_tokens: 7,
      cache_creation_input_tokens: 3,
      cache_read_input_tokens: 10,
      thinking_tokens: 2,
    })
    expect(Object.keys(usage.model_usage)).not.toContain('claude-haiku-5')
  })

  it('空文件 → 全零，不抛', async () => {
    const parsed = await parseSessionFile(SESSION_B)
    const usage = aggregateSessionUsage(parsed)
    expect(usage.total).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      thinking_tokens: 0,
    })
    expect(usage.model_usage).toEqual({})
  })
})
