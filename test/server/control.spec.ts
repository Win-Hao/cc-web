/**
 * M6：控制协议的 HTTP 面 —— set_model / set_permission_mode / list_models。
 *
 * 帧、request_id、initialize 握手都在引擎里（D8，test/engine/protocol.spec.ts）；
 * 这里只看路由把请求交给引擎、把应答 / 失败翻成信封。
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
import type { FakeEngine } from '../fixtures/fake-engine.js'

function setup() {
  const { factory, engines, calls } = fakeEngines()
  const registry = new SessionRegistry({ hub: new SessionHub(), factory })
  const app = createApp({ projectsRoot: mkdtempSync(join(tmpdir(), 'cc-web-control-')), registry })
  return { app, registry, engines, calls }
}

async function postJson(app: Hono, path: string, body: unknown) {
  const res = await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

async function getJson(app: Hono, path: string) {
  const res = await app.request(path)
  return { status: res.status, body: await res.json() }
}

/** 等引擎收到第 n 个控制请求 */
async function control(engines: Map<string, FakeEngine>, n = 0) {
  let engine: FakeEngine | undefined
  await waitFor(() => {
    engine = engines.get('s1')
    expect(engine?.controls.length).toBeGreaterThan(n)
  })
  return { engine: engine!, call: engine!.controls[n]! }
}

describe('控制请求经由引擎', () => {
  it('POST /model：对 idle 会话拉起引擎，引擎收到 set_model{model}，应答后 code 0', async () => {
    const { app, engines, calls } = setup()
    const p = postJson(app, '/api/v1/sessions/s1/model', { model: 'claude-sonnet-5' })
    const { engine, call } = await control(engines)
    expect(engine.started).toBe(true)
    expect(call.subtype).toBe('set_model')
    expect(call.payload).toEqual({ model: 'claude-sonnet-5' })
    call.resolve()
    expect((await p).body.code).toBe(0)
    expect(calls).toHaveLength(1)
  })

  it('POST /permission-mode → set_permission_mode{mode}；同一会话复用同一引擎', async () => {
    const { app, engines, calls } = setup()
    const p1 = postJson(app, '/api/v1/sessions/s1/model', { model: 'claude-sonnet-5' })
    ;(await control(engines)).call.resolve()
    await p1
    const p2 = postJson(app, '/api/v1/sessions/s1/permission-mode', { mode: 'plan' })
    const { call } = await control(engines, 1)
    expect(call.subtype).toBe('set_permission_mode')
    expect(call.payload).toEqual({ mode: 'plan' })
    call.resolve()
    expect((await p2).body.code).toBe(0)
    expect(calls).toHaveLength(1) // 没有第二次 spawn
  })

  it('缺参数 → 信封错误码，不碰引擎', async () => {
    const { app, engines } = setup()
    expect((await postJson(app, '/api/v1/sessions/s1/model', {})).body.code).toBe(40001)
    expect((await postJson(app, '/api/v1/sessions/s1/permission-mode', {})).body.code).toBe(40002)
    expect(engines.size).toBe(0)
  })
})

describe('控制失败 → 信封（HTTP 仍 200）', () => {
  it('对端 error → code !== 0，msg 带原因', async () => {
    const { app, engines } = setup()
    const p = postJson(app, '/api/v1/sessions/s1/model', { model: 'bad-model' })
    ;(await control(engines)).call.reject('unknown model')
    const { status, body } = await p
    expect(status).toBe(200)
    expect(body.code).toBe(50201)
    expect(body.msg).toContain('unknown model')
  })

  it('超时 / 引擎死亡（引擎侧 reject）→ code !== 0，请求不挂起', async () => {
    const { app, engines } = setup()
    const p = postJson(app, '/api/v1/sessions/s1/model', { model: 'claude-sonnet-5' })
    ;(await control(engines)).call.reject('control request timed out: set_model')
    const { body } = await p
    expect(body.code).not.toBe(0)
    expect(body.msg).toContain('timed out')
  })
})

describe('GET /api/v1/sessions/:id/models', () => {
  it('list_models 返回可用模型列表（不硬编码）', async () => {
    const { app, engines } = setup()
    const p = getJson(app, '/api/v1/sessions/s1/models')
    const { call } = await control(engines)
    expect(call.subtype).toBe('list_models')
    // 形状对齐录制的真实响应（control.ndjson：value / displayName / ...）
    call.resolve({
      models: [
        { value: 'default', resolvedModel: 'claude-opus-5[1m]', displayName: 'Default (recommended)' },
        { value: 'claude-sonnet-5', displayName: 'Sonnet' },
      ],
    })
    const { body } = await p
    expect(body.code).toBe(0)
    expect(body.data.models).toHaveLength(2)
    expect(body.data.models[0].value).toBe('default')
  })

  it('list_models 失败 → code !== 0（前端据此走兜底，不至于下拉框空白）', async () => {
    const { app, engines } = setup()
    const p = getJson(app, '/api/v1/sessions/s1/models')
    ;(await control(engines)).call.reject('not supported')
    expect((await p).body.code).not.toBe(0)
  })
})

describe('切模型之后', () => {
  it('会话没断：同一个引擎实例，还能继续发 prompt', async () => {
    const { app, registry, engines } = setup()
    const p = postJson(app, '/api/v1/sessions/s1/model', { model: 'claude-sonnet-5' })
    const { engine, call } = await control(engines)
    call.resolve()
    expect((await p).body.code).toBe(0)

    const pr = await postJson(app, '/api/v1/sessions/s1/prompt', { text: 'next turn' })
    expect(pr.body.code).toBe(0)
    expect(registry.get('s1')).toBe(engine)
    expect(engine.prompts).toEqual([{ text: 'next turn', images: [] }])
  })
})
