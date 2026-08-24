/**
 * M6：控制协议 —— set_model / set_permission_mode / list_models。
 *
 * 核心机制：对 idle 会话发控制请求会先拉起引擎，initialize 握手
 * 完成之后才发真正的请求（TDD M6 最后一条，这个功能的意义所在）。
 * 帧结构对照 pnpm test:contract 录制的真实帧（control.meta.json）。
 */
import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hono } from 'hono'
import { createApp } from '#/server/app.js'
import { SessionHub } from '#/server/hub.js'
import { SessionRegistry } from '#/server/registry.js'

const CONTROL_META = fileURLToPath(
  new URL('../fixtures/recorded/control.meta.json', import.meta.url),
)

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

const tmpdirs: string[] = []

function setup(controlTimeoutMs = 2000) {
  const hub = new SessionHub()
  const engines = new Map<string, FakeEngine>()
  const registry = new SessionRegistry({
    hub,
    factory: (id) => {
      const e = new FakeEngine()
      engines.set(id, e)
      return e
    },
    controlTimeoutMs,
  })
  const dir = mkdtempSync(join(tmpdir(), 'cc-web-control-'))
  tmpdirs.push(dir)
  const app = createApp({ projectsRoot: dir, registry })
  return { app, registry, engines }
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

function respondOk(engine: FakeEngine, frame: SentFrame, response: unknown = {}): void {
  engine.emit('message', {
    type: 'control_response',
    response: { subtype: 'success', request_id: frame.request_id, response },
  })
}

function respondErr(engine: FakeEngine, frame: SentFrame, error: string): void {
  engine.emit('message', {
    type: 'control_response',
    response: { subtype: 'error', request_id: frame.request_id, error },
  })
}

/** 驱动一次控制请求走完 initialize 门控，返回真正的请求帧。 */
async function driveControl(engine: FakeEngine): Promise<SentFrame> {
  await waitFor(() => expect(engine.sent.length).toBeGreaterThan(0))
  const init = engine.sent[0]!
  expect(init.request.subtype).toBe('initialize')
  respondOk(engine, init, { pid: 1 })
  await waitFor(() => expect(engine.sent.length).toBe(2))
  return engine.sent[1]!
}

describe('控制请求的 initialize 门控', () => {
  it('对 idle 会话发控制请求：先拉起引擎，initialize 完成后帧才发出', async () => {
    const { app, engines } = setup()
    const p = postJson(app, '/api/v1/sessions/s1/model', { model: 'claude-sonnet-5' })

    await waitFor(() => expect(engines.get('s1')?.sent).toHaveLength(1))
    const engine = engines.get('s1')!
    expect(engine.sent[0]).toMatchObject({
      type: 'control_request',
      request: { subtype: 'initialize' },
    })

    // initialize 没回之前，set_model 不许发
    await new Promise((r) => setTimeout(r, 50))
    expect(engine.sent).toHaveLength(1)

    respondOk(engine, engine.sent[0]!)
    await waitFor(() => expect(engine.sent).toHaveLength(2))
    expect(engine.sent[1]).toMatchObject({
      type: 'control_request',
      request: { subtype: 'set_model', model: 'claude-sonnet-5' },
    })

    respondOk(engine, engine.sent[1]!)
    const { body } = await p
    expect(body.code).toBe(0)
  })

  it('引擎已 initialize 后不重复握手', async () => {
    const { app, engines } = setup()
    const p1 = postJson(app, '/api/v1/sessions/s1/model', { model: 'claude-sonnet-5' })
    const engine = (await waitForEngine(engines)) 
    respondOk(engine, engine.sent[0]!)
    await waitFor(() => expect(engine.sent).toHaveLength(2))
    respondOk(engine, engine.sent[1]!)
    await p1

    const p2 = postJson(app, '/api/v1/sessions/s1/permission-mode', { mode: 'plan' })
    await waitFor(() => expect(engine.sent).toHaveLength(3))
    // 没有第二个 initialize
    expect(
      engine.sent.filter((f) => f.request.subtype === 'initialize'),
    ).toHaveLength(1)
    expect(engine.sent[2]).toMatchObject({
      request: { subtype: 'set_permission_mode', mode: 'plan' },
    })
    respondOk(engine, engine.sent[2]!)
    const { body } = await p2
    expect(body.code).toBe(0)
  })

  it('发出的帧结构与录制的真实帧一致（契约钉死）', async () => {
    const meta = JSON.parse(readFileSync(CONTROL_META, 'utf8')) as { sent: string[] }
    const recordedInit = JSON.parse(meta.sent[0]!) as SentFrame
    const recordedSetModel = JSON.parse(meta.sent[2]!) as SentFrame

    const { app, engines } = setup()
    const p = postJson(app, '/api/v1/sessions/s1/model', { model: 'claude-sonnet-5' })
    await waitFor(() => expect(engines.get('s1')?.sent).toHaveLength(1))
    const engine = engines.get('s1')!
    const req = await driveControl(engine)
    respondOk(engine, req)
    await p

    const sentInit = engine.sent[0]!
    expect(Object.keys(sentInit).sort()).toEqual(Object.keys(recordedInit).sort())
    expect(sentInit.type).toBe(recordedInit.type)
    expect(Object.keys(sentInit.request).sort()).toEqual(
      Object.keys(recordedInit.request).sort(),
    )
    expect(Object.keys(req.request).sort()).toEqual(
      Object.keys(recordedSetModel.request).sort(),
    )
  })
})

async function waitForEngine(engines: Map<string, FakeEngine>): Promise<FakeEngine> {
  let engine: FakeEngine | undefined
  await waitFor(() => {
    engine = engines.get('s1')
    expect(engine).toBeDefined()
  })
  return engine!
}

describe('控制响应', () => {
  it('control_response error → 信封 code !== 0', async () => {
    const { app, engines } = setup()
    const p = postJson(app, '/api/v1/sessions/s1/model', { model: 'bad-model' })
    const engine = await waitForEngine(engines)
    const req = await driveControl(engine)
    respondErr(engine, req, 'unknown model')
    const { body } = await p
    expect(body.code).not.toBe(0)
  })

  it('控制请求超时会 reject，不会永久挂起', async () => {
    const { app, engines } = setup(50) // 50ms 超时
    const p = postJson(app, '/api/v1/sessions/s1/model', { model: 'claude-sonnet-5' })
    await waitForEngine(engines)
    // 谁也不应答：initialize 超时
    const { body } = await p
    expect(body.code).not.toBe(0)
    expect(body.msg).toContain('timed out')
  })

  it('等待响应期间引擎死了 → reject，不挂起', async () => {
    const { app, engines } = setup(5000)
    const p = postJson(app, '/api/v1/sessions/s1/model', { model: 'claude-sonnet-5' })
    const engine = await waitForEngine(engines)
    await waitFor(() => expect(engine.sent).toHaveLength(1))
    engine.emit('exit', 1, null)
    const { body } = await p
    expect(body.code).not.toBe(0)
  })
})

describe('GET /api/v1/sessions/:id/models', () => {
  it('list_models 返回可用模型列表（不硬编码）', async () => {
    const { app, engines } = setup()
    const p = getJson(app, '/api/v1/sessions/s1/models')
    const engine = await waitForEngine(engines)
    const req = await driveControl(engine)
    expect(req.request.subtype).toBe('list_models')
    // 形状对齐录制的真实响应（control.ndjson：value / displayName / ...）
    respondOk(engine, req, {
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
    const engine = await waitForEngine(engines)
    const req = await driveControl(engine)
    respondErr(engine, req, 'not supported')
    const { body } = await p
    expect(body.code).not.toBe(0)
  })
})

describe('切模型之后', () => {
  it('会话没断：同一个引擎实例，还能继续发 prompt', async () => {
    const { app, registry, engines } = setup()
    const p = postJson(app, '/api/v1/sessions/s1/model', { model: 'claude-sonnet-5' })
    const engine = await waitForEngine(engines)
    const req = await driveControl(engine)
    respondOk(engine, req)
    const { body } = await p
    expect(body.code).toBe(0)

    const before = engine.sent.length
    const pr = await postJson(app, '/api/v1/sessions/s1/prompt', { text: 'next turn' })
    expect(pr.body.code).toBe(0)
    expect(registry.get('s1')).toBe(engine)
    expect(engine.sent.length).toBe(before + 1)
    expect(engine.sent[engine.sent.length - 1]).toMatchObject({ type: 'user' })
  })
})
