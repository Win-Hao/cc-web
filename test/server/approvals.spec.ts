/**
 * M7：工具审批 —— 最容易做错的里程碑。
 *
 * 三件事叠一起（RISKS R2/R5）：超时（不做就永久卡死引擎）、
 * 去重（同一 requestId 会从 initialize 的 pending_permission_requests
 * 和实时帧各来一次）、取消（对方可能撤回）。
 */
import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hono } from 'hono'
import { createApp } from '#/server/app.js'
import { SessionHub } from '#/server/hub.js'
import type { HubEvent } from '#/server/hub.js'
import { SessionRegistry } from '#/server/registry.js'

interface SentFrame {
  type: string
  request_id?: string
  response?: { subtype: string; request_id: string; response?: Record<string, unknown> }
  request?: Record<string, unknown>
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

function setup(opts: { approvalTimeoutMs?: number; controlTimeoutMs?: number } = {}) {
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
    ...(opts.approvalTimeoutMs !== undefined
      ? { approvalTimeoutMs: opts.approvalTimeoutMs }
      : {}),
    ...(opts.controlTimeoutMs !== undefined ? { controlTimeoutMs: opts.controlTimeoutMs } : {}),
  })
  const dir = mkdtempSync(join(tmpdir(), 'cc-web-approval-'))
  tmpdirs.push(dir)
  const app = createApp({ projectsRoot: dir, registry })
  return { app, registry, engines, events }
}

function canUseTool(requestId: string, toolName = 'Bash') {
  return {
    type: 'control_request',
    request_id: requestId,
    request: { subtype: 'can_use_tool', tool_name: toolName, input: { command: 'ls' } },
  }
}

function cancelRequest(requestId: string) {
  return { type: 'control_cancel_request', request_id: requestId }
}

async function postJson(app: Hono, path: string, body: unknown) {
  const res = await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
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

function responsesFor(engine: FakeEngine, requestId: string) {
  return engine.sent.filter(
    (f) => f.type === 'control_response' && f.response?.request_id === requestId,
  )
}

async function ensureWithApproval(
  registry: SessionRegistry,
  engines: Map<string, FakeEngine>,
  requestId = 'req-1',
) {
  await registry.ensure('s1')
  const engine = engines.get('s1')!
  engine.emit('message', canUseTool(requestId))
  return engine
}

describe('can_use_tool → approval 事件', () => {
  it('收到 can_use_tool → 广播 approval 事件（带 requestId/工具名/入参），状态变 waiting-approval', async () => {
    const { registry, engines, events } = setup()
    await ensureWithApproval(registry, engines)
    const approval = events.find((e) => e.event === 'approval')
    expect(approval).toBeDefined()
    expect(approval!.data).toMatchObject({ requestId: 'req-1', tool_name: 'Bash' })
    expect(registry.state('s1')).toBe('waiting-approval')
  })

  it('同一 requestId 到达两次（initialize 的 pending_permission_requests + 实时帧）→ 只 emit 一个 approval 事件（R5 去重）', async () => {
    const { registry, engines, events } = setup()
    const p = registry.setModel('s1', 'claude-sonnet-5')
    const engine = engines.get('s1')!
    await waitFor(() => expect(engine.sent).toHaveLength(1))
    // initialize 响应里带待审批请求
    engine.emit('message', {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: engine.sent[0]!.request_id,
        response: { pending_permission_requests: [canUseTool('req-dup')] },
      },
    })
    await waitFor(() => expect(engine.sent).toHaveLength(2))
    // 同一请求又作为实时帧到达
    engine.emit('message', canUseTool('req-dup'))
    // 收尾 set_model，别让 promise 挂着
    engine.emit('message', {
      type: 'control_response',
      response: { subtype: 'success', request_id: engine.sent[1]!.request_id },
    })
    await p

    expect(events.filter((e) => e.event === 'approval')).toHaveLength(1)
  })
})

describe('答复审批', () => {
  it('allow → 发出 behavior: allow 的 control_response，广播 approval_resolved，状态回 running', async () => {
    const { app, registry, engines, events } = setup()
    const engine = await ensureWithApproval(registry, engines)
    const { body } = await postJson(app, '/api/v1/sessions/s1/approvals/req-1', {
      behavior: 'allow',
    })
    expect(body.code).toBe(0)
    const resp = responsesFor(engine, 'req-1')
    expect(resp).toHaveLength(1)
    expect(resp[0]!.response).toMatchObject({
      subtype: 'success',
      response: { behavior: 'allow' },
    })
    expect(events.find((e) => e.event === 'approval_resolved')?.data).toMatchObject({
      requestId: 'req-1',
      outcome: 'allow',
    })
    expect(registry.state('s1')).toBe('running')
  })

  it('deny → 发出 behavior: deny，理由带回去', async () => {
    const { app, registry, engines } = setup()
    const engine = await ensureWithApproval(registry, engines)
    const { body } = await postJson(app, '/api/v1/sessions/s1/approvals/req-1', {
      behavior: 'deny',
      message: '不许动这个目录',
    })
    expect(body.code).toBe(0)
    expect(responsesFor(engine, 'req-1')[0]!.response?.response).toMatchObject({
      behavior: 'deny',
      message: '不许动这个目录',
    })
  })

  it('同一 requestId 答复后再 POST → 「已过期」，引擎只收到一帧（多标签页都点了）', async () => {
    const { app, registry, engines } = setup()
    const engine = await ensureWithApproval(registry, engines)
    const first = await postJson(app, '/api/v1/sessions/s1/approvals/req-1', {
      behavior: 'allow',
    })
    expect(first.body.code).toBe(0)
    const again = await postJson(app, '/api/v1/sessions/s1/approvals/req-1', {
      behavior: 'deny',
      message: 'late click',
    })
    expect(again.body.code).not.toBe(0)
    expect(responsesFor(engine, 'req-1')).toHaveLength(1)
  })

  it('未知 requestId → 报错不崩', async () => {
    const { app } = setup()
    const { body } = await postJson(app, '/api/v1/sessions/s1/approvals/nope', {
      behavior: 'allow',
    })
    expect(body.code).not.toBe(0)
  })

  it('同时来两个审批请求，各自独立（并发）', async () => {
    const { app, registry, engines, events } = setup()
    await registry.ensure('s1')
    const engine = engines.get('s1')!
    engine.emit('message', canUseTool('req-1', 'Bash'))
    engine.emit('message', canUseTool('req-2', 'Write'))
    expect(events.filter((e) => e.event === 'approval')).toHaveLength(2)

    await postJson(app, '/api/v1/sessions/s1/approvals/req-1', { behavior: 'allow' })
    await postJson(app, '/api/v1/sessions/s1/approvals/req-2', {
      behavior: 'deny',
      message: 'no',
    })
    expect(responsesFor(engine, 'req-1')[0]!.response?.response).toMatchObject({
      behavior: 'allow',
    })
    expect(responsesFor(engine, 'req-2')[0]!.response?.response).toMatchObject({
      behavior: 'deny',
    })
    expect(events.filter((e) => e.event === 'approval_resolved')).toHaveLength(2)
  })
})

describe('超时（R2：不做就永久卡死引擎）', () => {
  it('超时未响应 → 自动 deny，广播 approval_resolved（浏览器全断开也走——本测试就没开 WS）', async () => {
    const { registry, engines, events } = setup({ approvalTimeoutMs: 30 })
    await ensureWithApproval(registry, engines)
    const engine = engines.get('s1')!
    await waitFor(() => {
      const resp = responsesFor(engine, 'req-1')
      expect(resp).toHaveLength(1)
      expect(resp[0]!.response?.response).toMatchObject({ behavior: 'deny' })
    })
    expect(events.find((e) => e.event === 'approval_resolved')?.data).toMatchObject({
      requestId: 'req-1',
      outcome: 'timeout',
    })
    expect(registry.state('s1')).toBe('running')
  })

  it('超时之后用户才点 → 不崩，返回「已过期」，不再发第二帧', async () => {
    const { app, registry, engines } = setup({ approvalTimeoutMs: 30 })
    await ensureWithApproval(registry, engines)
    const engine = engines.get('s1')!
    await waitFor(() => expect(responsesFor(engine, 'req-1')).toHaveLength(1))
    const { body } = await postJson(app, '/api/v1/sessions/s1/approvals/req-1', {
      behavior: 'allow',
    })
    expect(body.code).not.toBe(0)
    expect(responsesFor(engine, 'req-1')).toHaveLength(1)
  })
})

describe('取消（对方撤回还在飞的请求）', () => {
  it('收到 control_cancel_request → 停止等待，广播 cancelled，之后不再答复', async () => {
    const { app, registry, engines, events } = setup({ approvalTimeoutMs: 50 })
    const engine = await ensureWithApproval(registry, engines)
    engine.emit('message', cancelRequest('req-1'))

    expect(events.find((e) => e.event === 'approval_resolved')?.data).toMatchObject({
      requestId: 'req-1',
      outcome: 'cancelled',
    })
    // 取消后即便过了超时点也不许再发 deny（timer 必须清了）
    await new Promise((r) => setTimeout(r, 100))
    expect(responsesFor(engine, 'req-1')).toHaveLength(0)
    // 用户再点 → 已过期
    const { body } = await postJson(app, '/api/v1/sessions/s1/approvals/req-1', {
      behavior: 'allow',
    })
    expect(body.code).not.toBe(0)
  })

  it('引擎死了 → 待审批全部取消并广播（不留挂起的 timer）', async () => {
    const { registry, engines, events } = setup({ approvalTimeoutMs: 60_000 })
    const engine = await ensureWithApproval(registry, engines)
    engine.emit('exit', 1, null)
    expect(events.find((e) => e.event === 'approval_resolved')?.data).toMatchObject({
      requestId: 'req-1',
      outcome: 'cancelled',
    })
  })
})
