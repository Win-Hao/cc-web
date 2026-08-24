/**
 * M30：context 窗口用量 —— get_context_usage 透传（裁剪成三个字段）。
 * 没有活引擎 → null 且绝不 spawn（和 /usage 的守卫同款）。
 */
import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
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
  const app = createApp({ projectsRoot: mkdtempSync(join(tmpdir(), 'cc-web-ctx-')), registry })
  return { app, registry, engines }
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
    expect(body.data).toEqual({ total_tokens: 201000, max_tokens: 1000000, percentage: 20 })
  })

  it('没有活引擎 → null，绝不 spawn', async () => {
    const { app, engines } = setup()
    const body = (await (await app.request('/api/v1/sessions/s1/context')).json()) as {
      code: number
      data: unknown
    }
    expect(body.code).toBe(0)
    expect(body.data).toBeNull()
    expect(engines.size).toBe(0)
  })
})
