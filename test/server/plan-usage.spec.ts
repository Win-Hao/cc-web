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

describe('GET /api/v1/plan-usage', () => {
  it('没有活引擎：临时空白引擎拿完即停', async () => {
    const { app, calls, engines } = setup()
    const body = (await (await app.request('/api/v1/plan-usage')).json()) as {
      code: number
      data: { rate_limits_available: boolean; rate_limits: { five_hour: { utilization: number } } }
    }
    expect(body.code).toBe(0)
    expect(body.data.rate_limits.five_hour.utilization).toBe(21)
    expect(calls[0]?.newSessionCwd).toBeTypeOf('string')
    await new Promise((r) => setTimeout(r, 20))
    expect(engines[0]!.stopped).toBe(true)
  })

  it('有活引擎：直接借用，不再 spawn 也不停它', async () => {
    const { app, registry, calls, engines } = setup()
    await registry.ensure('s1')
    const body = (await (await app.request('/api/v1/plan-usage')).json()) as { code: number }
    expect(body.code).toBe(0)
    expect(calls).toHaveLength(1) // 只有 ensure 那一次
    expect(engines[0]!.stopped).toBe(false)
  })
})
