/**
 * M24：思考程度 —— POST /sessions/:id/effort → apply_flag_settings
 * 带 effortLevel（sdk.d.ts；max 是会话级）。
 */
import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hono } from 'hono'
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
    this.sent.push(frame as SentFrame)
  }
}

async function postJson(app: Hono, path: string, body: unknown) {
  const res = await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

function respondOk(engine: FakeEngine, frame: SentFrame): void {
  engine.emit('message', {
    type: 'control_response',
    response: { subtype: 'success', request_id: frame.request_id, response: {} },
  })
}

async function waitFor(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 3000
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

describe('POST /api/v1/sessions/:id/effort', () => {
  it('发出 apply_flag_settings { effortLevel }', async () => {
    const hub = new SessionHub()
    const engines = new Map<string, FakeEngine>()
    const registry = new SessionRegistry({
      hub,
      factory: (id) => {
        const e = new FakeEngine()
        engines.set(id, e)
        return e
      },
    })
    const app = createApp({ projectsRoot: mkdtempSync(join(tmpdir(), 'cc-web-eff-')), registry })

    const p = postJson(app, '/api/v1/sessions/s1/effort', { effort: 'max' })
    await waitFor(() => expect(engines.get('s1')!.sent).toHaveLength(1))
    const engine = engines.get('s1')!
    respondOk(engine, engine.sent[0]!) // initialize 门控
    await waitFor(() => expect(engine.sent).toHaveLength(2))
    const req = engine.sent[1]!
    expect(req.request.subtype).toBe('apply_flag_settings')
    expect(req.request.settings).toEqual({ effortLevel: 'max' })
    respondOk(engine, req)
    expect((await p).body.code).toBe(0)
  })

  it('缺 effort → 40001', async () => {
    const registry = new SessionRegistry({ hub: new SessionHub(), factory: () => new FakeEngine() })
    const app = createApp({ projectsRoot: mkdtempSync(join(tmpdir(), 'cc-web-eff-')), registry })
    expect((await postJson(app, '/api/v1/sessions/s1/effort', {})).body.code).toBe(40001)
  })
})
