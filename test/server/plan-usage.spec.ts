/**
 * M32：账户级套餐用量 —— 优先借活引擎；没有就临时空白引擎拿完即停。
 */
import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '#/server/app.js'
import { SessionHub } from '#/server/hub.js'
import { SessionRegistry } from '#/server/registry.js'
import type { EngineFactoryOptions } from '#/server/registry.js'

interface SentFrame {
  type: string
  request_id: string
  request: Record<string, unknown>
}

class FakeEngine extends EventEmitter {
  stopped = false
  sent: SentFrame[] = []
  async start() {}
  async stop() {
    this.stopped = true
    this.emit('exit', 0, null)
  }
  send(frame: unknown) {
    const f = frame as SentFrame
    this.sent.push(f)
    const respond = (response: unknown) =>
      this.emit('message', {
        type: 'control_response',
        response: { subtype: 'success', request_id: f.request_id, response },
      })
    if (f.request.subtype === 'initialize') setImmediate(() => respond({}))
    if (f.request.subtype === 'list_models') setImmediate(() => respond({ models: [] }))
    if (f.request.subtype === 'get_settings') setImmediate(() => respond({ applied: {} }))
    if (f.request.subtype === 'get_context_usage') setImmediate(() => respond({ maxTokens: 1000000 }))
    if (f.request.subtype === 'get_usage')
      setImmediate(() =>
        respond({
          session: {},
          rate_limits_available: true,
          rate_limits: { five_hour: { utilization: 21 } },
          subscription_type: 'pro',
        }),
      )
  }
}

function setup() {
  const calls: (EngineFactoryOptions | undefined)[] = []
  const engines: FakeEngine[] = []
  const registry = new SessionRegistry({
    hub: new SessionHub(),
    factory: (_id, opts) => {
      calls.push(opts)
      const e = new FakeEngine()
      engines.push(e)
      return e
    },
  })
  const app = createApp({ projectsRoot: mkdtempSync(join(tmpdir(), 'cc-web-plan-')), registry })
  return { app, registry, calls, engines }
}

describe('GET /api/v1/plan-usage（M34 缓存策略）', () => {
  it('冷启动：走元数据空白引擎（只此一次），之后命中缓存不再 spawn', async () => {
    const { app, calls, engines } = setup()
    const body = (await (await app.request('/api/v1/plan-usage')).json()) as {
      code: number
      data: { rate_limits: { five_hour: { utilization: number } }; fetched_at: number }
    }
    expect(body.code).toBe(0)
    expect(body.data.rate_limits.five_hour.utilization).toBe(21)
    expect(body.data.fetched_at).toBeTypeOf('number')
    expect(calls[0]?.newSessionCwd).toBeTypeOf('string') // 元数据空白引擎
    await new Promise((r) => setTimeout(r, 20))
    expect(engines[0]!.stopped).toBe(true) // 拿完即停

    const again = (await (await app.request('/api/v1/plan-usage')).json()) as { code: number }
    expect(again.code).toBe(0)
    expect(calls).toHaveLength(1) // 缓存命中，没有第二次 spawn
  })

  it('缓存未过期时有活引擎也不打扰它', async () => {
    const { app, registry, engines, calls } = setup()
    await app.request('/api/v1/plan-usage') // 预热缓存（spawn 1 次）
    await registry.ensure('s1') // spawn 第 2 次（业务会话）
    const sentBefore = engines[1]!.sent.length
    await app.request('/api/v1/plan-usage')
    expect(engines[1]!.sent.length).toBe(sentBefore) // 没找活引擎发 get_usage
    expect(calls).toHaveLength(2)
  })
})
