/**
 * M24：思考程度 —— POST /sessions/:id/effort → apply_flag_settings
 * 带 effortLevel（sdk.d.ts；max 是会话级）。
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hono } from 'hono'
import { createApp } from '#/server/app.js'
import { SessionHub } from '#/server/hub.js'
import { SessionRegistry } from '#/server/registry.js'
import { fakeEngines, waitFor } from '../fixtures/fake-engine.js'

function setup() {
  const { factory, engines } = fakeEngines()
  const registry = new SessionRegistry({ hub: new SessionHub(), factory })
  const app = createApp({ projectsRoot: mkdtempSync(join(tmpdir(), 'cc-web-eff-')), registry })
  return { app, engines }
}

async function postJson(app: Hono, path: string, body: unknown) {
  const res = await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

describe('POST /api/v1/sessions/:id/effort', () => {
  it('发出 apply_flag_settings { effortLevel }', async () => {
    const { app, engines } = setup()
    const p = postJson(app, '/api/v1/sessions/s1/effort', { effort: 'max' })
    await waitFor(() => expect(engines.get('s1')?.controls).toHaveLength(1))
    const call = engines.get('s1')!.controls[0]!
    expect(call.subtype).toBe('apply_flag_settings')
    expect(call.payload).toEqual({ settings: { effortLevel: 'max' } })
    call.resolve()
    expect((await p).body.code).toBe(0)
  })

  it('GET /settings 透传 get_settings payload（applied.effort 当默认值）', async () => {
    const { app, engines } = setup()
    const p = app.request('/api/v1/sessions/s1/settings')
    await waitFor(() => expect(engines.get('s1')?.controls).toHaveLength(1))
    const call = engines.get('s1')!.controls[0]!
    expect(call.subtype).toBe('get_settings')
    call.resolve({ applied: { effort: 'max', model: 'claude-opus-5[1m]' } })
    const body = (await (await p).json()) as { code: number; data: { applied: { effort: string } } }
    expect(body.code).toBe(0)
    expect(body.data.applied.effort).toBe('max')
  })

  it('缺 effort → 40001', async () => {
    const { app, engines } = setup()
    expect((await postJson(app, '/api/v1/sessions/s1/effort', {})).body.code).toBe(40001)
    expect(engines.size).toBe(0)
  })
})
