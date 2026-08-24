/**
 * M9：用量 —— 走 get_usage 控制请求（不是 HTTP 端点、不是 statusline，
 * 那两条是作废方案，PROTOCOL §6）。
 *
 * 铁律（D5/R4）：拿不到就不显示，绝不让用量面板挂掉影响聊天。
 * rate_limits_available: false 是正常情况（API key / Bedrock / Vertex），
 * 返回 null + code 0，不是错误。
 */
import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import type { Hono } from 'hono'
import { createApp } from '#/server/app.js'
import { SessionHub } from '#/server/hub.js'
import type { HubEvent } from '#/server/hub.js'
import { SessionRegistry } from '#/server/registry.js'

const FIXTURES = fileURLToPath(new URL('../fixtures/sessions', import.meta.url))
const SESSION_A = 'aaaaaaaa-0000-0000-0000-000000000001'

interface SentFrame {
  type: string
  request_id: string
  request: Record<string, unknown>
}

class FakeEngine extends EventEmitter {
  pid = 4242
  sent: SentFrame[] = []
  async start() {}
  async stop() {}
  send(frame: unknown) {
    this.sent.push(frame as SentFrame)
  }
}

function setup(opts: { controlTimeoutMs?: number } = {}) {
  const hub = new SessionHub()
  const events: HubEvent[] = []
  hub.subscribe('s1', (e) => events.push(e))
  const engines = new Map<string, FakeEngine>()
  const registry = new SessionRegistry({
    hub,
    factory: (id) => {
      const e = new FakeEngine()
      engines.set(id, e)
      return e
    },
    ...(opts.controlTimeoutMs !== undefined ? { controlTimeoutMs: opts.controlTimeoutMs } : {}),
  })
  const app = createApp({ projectsRoot: FIXTURES, registry })
  return { app, registry, engines, events }
}

async function getJson(app: Hono, path: string) {
  const res = await app.request(path)
  return { status: res.status, body: await res.json() }
}

async function waitFor(assertion: () => void, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      assertion()
      return
    } catch (err) {
      if (Date.now() > deadline) throw err
      await new Promise((r) => setTimeout(r, 10))
    }
  }
}

function respondOk(engine: FakeEngine, frame: SentFrame, response: unknown): void {
  engine.emit('message', {
    type: 'control_response',
    response: { subtype: 'success', request_id: frame.request_id, response },
  })
}

/** 驱动 initialize 门控，等到 get_usage 帧发出后返回它。 */
async function driveGetUsage(engine: FakeEngine): Promise<SentFrame> {
  await waitFor(() => expect(engine.sent).toHaveLength(1))
  respondOk(engine, engine.sent[0]!, {})
  await waitFor(() => expect(engine.sent).toHaveLength(2))
  const req = engine.sent[1]!
  expect(req.request.subtype).toBe('get_usage')
  return req
}

describe('GET /api/v1/sessions/:id/usage（引擎活着）', () => {
  it('从 get_usage 拿到 session 段：total_cost_usd + 按模型分的 model_usage', async () => {
    const { app, registry, engines } = setup()
    await registry.ensure('s1')
    const p = getJson(app, '/api/v1/sessions/s1/usage')
    const engine = engines.get('s1')!
    const req = await driveGetUsage(engine)
    respondOk(engine, req, {
      session: {
        total_cost_usd: 1.23,
        total_lines_added: 42,
        model_usage: { 'claude-opus-5': { input_tokens: 100, cost_usd: 1.0 } },
      },
      rate_limits_available: true,
      rate_limits: null,
    })
    const { body } = await p
    expect(body.code).toBe(0)
    expect(body.data.total_cost_usd).toBe(1.23)
    expect(body.data.model_usage['claude-opus-5']).toBeDefined()
    expect(body.data.total_lines_added).toBe(42)
  })

  it('get_usage 返回了没见过的字段 → 不崩（上游会加字段，原样透传）', async () => {
    const { app, registry, engines } = setup()
    await registry.ensure('s1')
    const p = getJson(app, '/api/v1/sessions/s1/usage')
    const engine = engines.get('s1')!
    const req = await driveGetUsage(engine)
    respondOk(engine, req, {
      session: { total_cost_usd: 0, model_usage: {}, brand_new_field: { nested: [1, 2] } },
    })
    const { body } = await p
    expect(body.code).toBe(0)
    expect(body.data.brand_new_field).toEqual({ nested: [1, 2] })
  })
})

describe('GET /api/v1/usage（订阅额度）', () => {
  it('返回 rate_limits，utilization 是 0-100', async () => {
    const { app, registry, engines } = setup()
    await registry.ensure('s1')
    const p = getJson(app, '/api/v1/usage?session=s1')
    const engine = engines.get('s1')!
    const req = await driveGetUsage(engine)
    respondOk(engine, req, {
      session: { total_cost_usd: 0, model_usage: {} },
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 42.5, resets_at: '2026-08-24T20:00:00Z' },
        seven_day: { utilization: 10, resets_at: '2026-08-31T00:00:00Z' },
      },
    })
    const { body } = await p
    expect(body.code).toBe(0)
    expect(body.data.five_hour.utilization).toBe(42.5)
    expect(body.data.five_hour.utilization).toBeGreaterThanOrEqual(0)
    expect(body.data.five_hour.utilization).toBeLessThanOrEqual(100)
  })

  it('rate_limits_available: false → 返回 null，code 仍是 0（API key 用户，正常情况）', async () => {
    const { app, registry, engines } = setup()
    await registry.ensure('s1')
    const p = getJson(app, '/api/v1/usage?session=s1')
    const engine = engines.get('s1')!
    const req = await driveGetUsage(engine)
    respondOk(engine, req, {
      session: { total_cost_usd: 0.5, model_usage: {} },
      subscription_type: null,
      rate_limits_available: false,
      rate_limits: null,
    })
    const { body } = await p
    expect(body.code).toBe(0)
    expect(body.data).toBeNull()
  })

  it('会话没有活引擎 → null，且不为查用量 spawn 引擎（D5）', async () => {
    const { app, engines } = setup() // 不 ensure —— 没有引擎
    const { body } = await getJson(app, '/api/v1/usage?session=s1')
    expect(body.code).toBe(0)
    expect(body.data).toBeNull()
    expect(engines.size).toBe(0) // 关键：查用量不许 spawn
  })

  it('get_usage 超时 → 返回 null，不抛', async () => {
    const { app, registry, engines } = setup({ controlTimeoutMs: 30 })
    await registry.ensure('s1')
    const p = getJson(app, '/api/v1/usage?session=s1')
    await waitFor(() => expect(engines.get('s1')!.sent.length).toBeGreaterThan(0))
    // 谁也不应答：initialize 超时 → get_usage 拿不到 → null
    const { body } = await p
    expect(body.code).toBe(0)
    expect(body.data).toBeNull()
  })
})

describe('rate_limit_event 推送', () => {
  it('通过 WS 转给前端，status 原样保留（rejected 能区分出来）', async () => {
    const { registry, engines, events } = setup()
    await registry.ensure('s1')
    engines.get('s1')!.emit('message', {
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', utilization: 100 },
    })
    const e = events.find((ev) => ev.event === 'rate_limit')
    expect(e).toBeDefined()
    expect((e!.data as { rate_limit_info: { status: string } }).rate_limit_info.status).toBe(
      'rejected',
    )
  })
})

describe('降级与隔离（D5）', () => {
  it('引擎已回收的会话：降级到 jsonl 聚合，接口形状不变（token 量有，官方成本没有）', async () => {
    const { app } = setup() // 不 ensure —— 没有引擎
    const { body } = await getJson(app, `/api/v1/sessions/${SESSION_A}/usage`)
    expect(body.code).toBe(0)
    expect(body.data.total_cost_usd).toBeNull()
    // 同 fixture A 的聚合：opus 11/22 + sonnet 3/4
    expect(body.data.model_usage['claude-opus-5'].input_tokens).toBe(11)
    expect(body.data.total.output_tokens).toBe(26)
  })

  it('用量拿不到时，/history 等接口不受影响', async () => {
    const { app, registry, engines } = setup({ controlTimeoutMs: 30 })
    await registry.ensure('s1')
    const usagePromise = getJson(app, '/api/v1/usage?session=s1')
    await waitFor(() => expect(engines.get('s1')!.sent.length).toBeGreaterThan(0))
    const usage = await usagePromise
    expect(usage.body.data).toBeNull()
    // 用量挂了，history 照常
    const history = await getJson(app, `/api/v1/sessions/${SESSION_A}/history`)
    expect(history.body.code).toBe(0)
    expect(history.body.data.messages.length).toBeGreaterThan(0)
  })
})
