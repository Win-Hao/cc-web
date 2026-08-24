/**
 * M30：context 窗口用量 —— get_context_usage 透传（裁剪成三个字段）。
 * 没有活引擎 → null 且绝不 spawn（和 /usage 的守卫同款）。
 */
import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '#/server/app.js'
import { SessionHub } from '#/server/hub.js'
import { SessionRegistry } from '#/server/registry.js'

interface SentFrame {
  type: string
  request_id: string
  request: Record<string, unknown>
}

class FakeEngine extends EventEmitter {
  sent: SentFrame[] = []
  async start() {}
  async stop() {}
  send(frame: unknown) {
    const f = frame as SentFrame
    this.sent.push(f)
    const respond = (response: unknown) =>
      this.emit('message', {
        type: 'control_response',
        response: { subtype: 'success', request_id: f.request_id, response },
      })
    if (f.request.subtype === 'initialize') setImmediate(() => respond({}))
    if (f.request.subtype === 'get_context_usage')
      setImmediate(() => respond({ totalTokens: 201000, maxTokens: 1000000, percentage: 20, categories: [] }))
    if (f.request.subtype === 'list_models') setImmediate(() => respond({ models: [] }))
    if (f.request.subtype === 'get_settings') setImmediate(() => respond({ applied: {} }))
  }
}

function setup() {
  const engines = new Map<string, FakeEngine>()
  const registry = new SessionRegistry({
    hub: new SessionHub(),
    factory: (id) => {
      const e = new FakeEngine()
      engines.set(id, e)
      return e
    },
  })
  const root = mkdtempSync(join(tmpdir(), 'cc-web-ctx-'))
  const app = createApp({ projectsRoot: root, registry })
  return { app, registry, engines, root }
}

describe('GET /api/v1/sessions/:id/context', () => {
  it('引擎活着：裁剪成 total/max/percentage 三个字段', async () => {
    const { app, registry } = setup()
    await registry.ensure('s1')
    const body = (await (await app.request('/api/v1/sessions/s1/context')).json()) as {
      code: number
      data: { total_tokens: number; max_tokens: number; percentage: number }
    }
    expect(body.code).toBe(0)
    expect(body.data).toEqual({ total_tokens: 201000, max_tokens: 1000000, percentage: 20, estimated: false })
  })

  it('没有活引擎且没有 jsonl → null，不为会话 spawn 引擎', async () => {
    const { app } = setup()
    const body = (await (await app.request('/api/v1/sessions/s1/context')).json()) as {
      code: number
      data: unknown
    }
    expect(body.code).toBe(0)
    expect(body.data).toBeNull()
  })

  it('引擎不在但有 jsonl → 末轮 usage 估算，窗口取元数据引擎的 maxTokens（M31）', async () => {
    const { app, root } = setup()
    mkdirSync(join(root, '-Users-x-p'))
    writeFileSync(
      join(root, '-Users-x-p', 'eeeeeeee-0000-0000-0000-00000000000e.jsonl'),
      [
        JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'hi' } }),
        JSON.stringify({
          type: 'assistant', uuid: 'a1', parentUuid: 'u1',
          message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: 'ok' }],
            usage: { input_tokens: 100000, output_tokens: 1000, cache_creation_input_tokens: 50000, cache_read_input_tokens: 50000 } },
        }),
      ].join('\n') + '\n',
    )
    const body = (await (
      await app.request('/api/v1/sessions/eeeeeeee-0000-0000-0000-00000000000e/context')
    ).json()) as { code: number; data: { total_tokens: number; max_tokens: number; estimated: boolean } }
    expect(body.code).toBe(0)
    expect(body.data.total_tokens).toBe(201000)
    expect(body.data.max_tokens).toBe(1000000) // 元数据引擎给的窗口
    expect(body.data.estimated).toBe(true)
  })
})
