/**
 * M3：HTTP 只读接口。
 *
 * 信封约定（API.md）：业务结果看 code（0 = 成功），HTTP 状态码只表达
 * 传输层 —— 所以「不存在的会话」HTTP 仍是 200，但 code !== 0。
 * history 用 cursor 分页（R9：jsonl 是 append-only，不用 offset）。
 */
import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { createApp } from '#/server/app.js'

const FIXTURES = fileURLToPath(new URL('../fixtures/sessions', import.meta.url))
const SESSION_A = 'aaaaaaaa-0000-0000-0000-000000000001'

const app = createApp({ projectsRoot: FIXTURES })

async function getJson(path: string) {
  const res = await app.request(path)
  return { status: res.status, body: await res.json() }
}

describe('GET /api/v1/meta', () => {
  it('返回信封，code === 0', async () => {
    const { status, body } = await getJson('/api/v1/meta')
    expect(status).toBe(200)
    expect(body.code).toBe(0)
    expect(body.msg).toBe('success')
    expect(body.trace_id).toBeTypeOf('string')
    expect(body.data.name).toBe('cc-web')
  })
})

describe('GET /api/v1/sessions', () => {
  it('返回会话列表', async () => {
    const { status, body } = await getJson('/api/v1/sessions')
    expect(status).toBe(200)
    expect(body.code).toBe(0)
    expect(body.data.sessions).toHaveLength(3)
    const a = body.data.sessions.find((s: { session_id: string }) => s.session_id === SESSION_A)
    expect(a.cwd).toBe('/Users/x/proj-a')
    expect(a.first_message).toBe('hello from session A')
  })
})

describe('GET /api/v1/sessions/:id/history', () => {
  it('返回归一化后的主线消息', async () => {
    const { status, body } = await getJson(`/api/v1/sessions/${SESSION_A}/history`)
    expect(status).toBe(200)
    expect(body.code).toBe(0)
    expect(body.data.messages.map((m: { uuid: string }) => m.uuid)).toEqual([
      'a-u1',
      'a-a1',
      'a-u2',
      'a-a2',
      'a-u3',
      'a-a3',
    ])
    expect(body.data.has_more).toBe(false)
    const [u1, a1] = body.data.messages
    expect(u1.text).toBe('hello from session A')
    expect(u1.role).toBe('user')
    expect(a1.text).toBe('hi A1')
    expect(a1.model).toBe('claude-opus-5')
    expect(a1.timestamp).toBe('2026-08-20T10:00:01.000Z')
  })

  it('cursor 分页：默认取最新 limit 条，before 向前翻，has_more 标识还有', async () => {
    const page1 = (await getJson(`/api/v1/sessions/${SESSION_A}/history?limit=2`)).body
    expect(page1.data.messages.map((m: { uuid: string }) => m.uuid)).toEqual(['a-u3', 'a-a3'])
    expect(page1.data.has_more).toBe(true)

    const cursor = page1.data.messages[0].cursor
    const page2 = (
      await getJson(`/api/v1/sessions/${SESSION_A}/history?limit=2&before=${cursor}`)
    ).body
    expect(page2.data.messages.map((m: { uuid: string }) => m.uuid)).toEqual(['a-u2', 'a-a2'])
    expect(page2.data.has_more).toBe(true)

    const page3 = (
      await getJson(
        `/api/v1/sessions/${SESSION_A}/history?limit=2&before=${page2.data.messages[0].cursor}`,
      )
    ).body
    expect(page3.data.messages.map((m: { uuid: string }) => m.uuid)).toEqual(['a-u1', 'a-a1'])
    expect(page3.data.has_more).toBe(false)
  })

  it('不存在的 id → 信封里 code !== 0，HTTP 仍是 200', async () => {
    const { status, body } = await getJson(
      '/api/v1/sessions/00000000-dead-beef-0000-000000000000/history',
    )
    expect(status).toBe(200)
    expect(body.code).not.toBe(0)
    expect(body.data).toBeNull()
  })

  it('空会话文件 → 空列表，不报错', async () => {
    const { body } = await getJson(
      '/api/v1/sessions/bbbbbbbb-0000-0000-0000-000000000002/history',
    )
    expect(body.code).toBe(0)
    expect(body.data.messages).toEqual([])
    expect(body.data.has_more).toBe(false)
  })
})

describe('未知路径', () => {
  it('404', async () => {
    const res = await app.request('/api/v1/nope')
    expect(res.status).toBe(404)
  })
})

describe('GET /api/v1/sessions/search（M44）', async () => {
  const { createApp } = await import('#/server/app.js')
  const { fileURLToPath } = await import('node:url')
  const FIXTURES = fileURLToPath(new URL('../fixtures/sessions', import.meta.url))

  it('search 路由不被 /sessions/:id 吃掉，q 过短拒绝', async () => {
    const app = createApp({ projectsRoot: FIXTURES })
    const res = await app.request('/api/v1/sessions/search?q=x')
    const body = (await res.json()) as { code: number }
    expect(body.code).toBe(40001)
  })

  it('全文命中返回 hits（session_id + snippet）', async () => {
    const app = createApp({ projectsRoot: FIXTURES })
    const res = await app.request('/api/v1/sessions/search?q=%E4%BD%A0%E5%A5%BD')
    const body = (await res.json()) as {
      code: number
      data: { hits: { session_id: string; snippet: string }[] }
    }
    expect(body.code).toBe(0)
    expect(Array.isArray(body.data.hits)).toBe(true)
  })
})
