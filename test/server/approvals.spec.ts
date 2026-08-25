/**
 * M7：工具审批 —— 最容易做错的里程碑。
 *
 * 这里测的是策略（RISKS R2）：超时（不做就永久卡死引擎）、取消、
 * 多标签页重复答复、引擎死亡。协议层的去重（R5：同一 requestId 从
 * pending_permission_requests 和实时帧各来一次）在 test/engine/protocol.spec.ts。
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hono } from 'hono'
import { createApp } from '#/server/app.js'
import { SessionHub } from '#/server/hub.js'
import type { HubEvent } from '#/server/hub.js'
import { SessionRegistry } from '#/server/registry.js'
import { fakeEngines, waitFor } from '../fixtures/fake-engine.js'
import type { FakeEngine } from '../fixtures/fake-engine.js'

function setup(opts: { approvalTimeoutMs?: number } = {}) {
  const hub = new SessionHub()
  const events: HubEvent[] = []
  hub.subscribe('s1', (e) => events.push(e))
  const { factory, engines } = fakeEngines()
  const registry = new SessionRegistry({
    hub,
    factory,
    ...(opts.approvalTimeoutMs !== undefined ? { approvalTimeoutMs: opts.approvalTimeoutMs } : {}),
  })
  const app = createApp({ projectsRoot: mkdtempSync(join(tmpdir(), 'cc-web-approval-')), registry })
  return { app, registry, engines, events }
}

async function postJson(app: Hono, path: string, body: unknown) {
  const res = await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

const answersFor = (engine: FakeEngine, requestId: string) => engine.answers.filter((a) => a.requestId === requestId)

/** 起引擎并让它发一个审批 */
async function ensureWithApproval(registry: SessionRegistry, engines: Map<string, FakeEngine>, requestId = 'req-1') {
  await registry.ensure('s1')
  const engine = engines.get('s1')!
  engine.approval({ requestId })
  return engine
}

describe('approval 事件 → 广播', () => {
  it('引擎发 approval → hub 广播 approval（带 requestId/工具名/入参），状态变 waiting-approval', async () => {
    const { registry, engines, events } = setup()
    await ensureWithApproval(registry, engines)
    const approval = events.find((e) => e.event === 'approval')
    expect(approval).toBeDefined()
    expect(approval!.data).toEqual({ requestId: 'req-1', tool_name: 'Bash', input: { command: 'ls' } })
    expect(registry.state('s1')).toBe('waiting-approval')
  })
})

describe('答复审批', () => {
  it('allow → 引擎收到 behavior: allow 的答复，广播 approval_resolved，状态回 running', async () => {
    const { app, registry, engines, events } = setup()
    const engine = await ensureWithApproval(registry, engines)
    const { body } = await postJson(app, '/api/v1/sessions/s1/approvals/req-1', { behavior: 'allow' })
    expect(body.code).toBe(0)
    expect(engine.answers).toEqual([{ requestId: 'req-1', decision: { behavior: 'allow' } }])
    expect(events.find((e) => e.event === 'approval_resolved')?.data).toMatchObject({
      requestId: 'req-1',
      outcome: 'allow',
    })
    expect(registry.state('s1')).toBe('running')
  })

  it('deny → behavior: deny，理由带回去', async () => {
    const { app, registry, engines } = setup()
    const engine = await ensureWithApproval(registry, engines)
    const { body } = await postJson(app, '/api/v1/sessions/s1/approvals/req-1', {
      behavior: 'deny',
      message: '不许动这个目录',
    })
    expect(body.code).toBe(0)
    expect(engine.answers[0]!.decision).toEqual({ behavior: 'deny', message: '不许动这个目录' })
  })

  it('同一 requestId 答复后再 POST → 「已过期」，引擎只收到一次答复（多标签页都点了）', async () => {
    const { app, registry, engines } = setup()
    const engine = await ensureWithApproval(registry, engines)
    const first = await postJson(app, '/api/v1/sessions/s1/approvals/req-1', { behavior: 'allow' })
    expect(first.body.code).toBe(0)
    const again = await postJson(app, '/api/v1/sessions/s1/approvals/req-1', { behavior: 'deny', message: 'late click' })
    expect(again.body.code).not.toBe(0)
    expect(answersFor(engine, 'req-1')).toHaveLength(1)
  })

  it('未知 requestId → 报错不崩', async () => {
    const { app } = setup()
    const { body } = await postJson(app, '/api/v1/sessions/s1/approvals/nope', { behavior: 'allow' })
    expect(body.code).not.toBe(0)
  })

  it('同时来两个审批请求，各自独立（并发）', async () => {
    const { app, registry, engines, events } = setup()
    await registry.ensure('s1')
    const engine = engines.get('s1')!
    engine.approval({ requestId: 'req-1', tool_name: 'Bash' })
    engine.approval({ requestId: 'req-2', tool_name: 'Write' })
    expect(events.filter((e) => e.event === 'approval')).toHaveLength(2)

    await postJson(app, '/api/v1/sessions/s1/approvals/req-1', { behavior: 'allow' })
    await postJson(app, '/api/v1/sessions/s1/approvals/req-2', { behavior: 'deny', message: 'no' })
    expect(answersFor(engine, 'req-1')[0]!.decision).toMatchObject({ behavior: 'allow' })
    expect(answersFor(engine, 'req-2')[0]!.decision).toMatchObject({ behavior: 'deny' })
    expect(events.filter((e) => e.event === 'approval_resolved')).toHaveLength(2)
  })
})

describe('超时（R2：不做就永久卡死引擎）', () => {
  it('超时未响应 → 自动 deny，广播 approval_resolved（浏览器全断开也走——本测试就没开 WS）', async () => {
    const { registry, engines, events } = setup({ approvalTimeoutMs: 30 })
    const engine = await ensureWithApproval(registry, engines)
    await waitFor(() => {
      const answers = answersFor(engine, 'req-1')
      expect(answers).toHaveLength(1)
      expect(answers[0]!.decision).toMatchObject({ behavior: 'deny' })
    })
    expect(events.find((e) => e.event === 'approval_resolved')?.data).toMatchObject({
      requestId: 'req-1',
      outcome: 'timeout',
    })
    expect(registry.state('s1')).toBe('running')
  })

  it('超时之后用户才点 → 不崩，返回「已过期」，不再答复第二次', async () => {
    const { app, registry, engines } = setup({ approvalTimeoutMs: 30 })
    const engine = await ensureWithApproval(registry, engines)
    await waitFor(() => expect(answersFor(engine, 'req-1')).toHaveLength(1))
    const { body } = await postJson(app, '/api/v1/sessions/s1/approvals/req-1', { behavior: 'allow' })
    expect(body.code).not.toBe(0)
    expect(answersFor(engine, 'req-1')).toHaveLength(1)
  })

  it('引擎正在死（答复抛错）：超时 deny 不崩，仍广播 approval_resolved', async () => {
    const { registry, engines, events } = setup({ approvalTimeoutMs: 30 })
    const engine = await ensureWithApproval(registry, engines)
    engine.answerApproval = () => {
      throw new Error('engine is not running')
    }
    await waitFor(() =>
      expect(events.find((e) => e.event === 'approval_resolved')?.data).toMatchObject({ requestId: 'req-1', outcome: 'timeout' }),
    )
  })
})

describe('取消（对方撤回还在飞的请求）', () => {
  it('approval-cancel → 停止等待，广播 cancelled，之后不再答复', async () => {
    const { app, registry, engines, events } = setup({ approvalTimeoutMs: 50 })
    const engine = await ensureWithApproval(registry, engines)
    engine.cancelApproval('req-1')

    expect(events.find((e) => e.event === 'approval_resolved')?.data).toMatchObject({
      requestId: 'req-1',
      outcome: 'cancelled',
    })
    // 取消后即便过了超时点也不许再答复 deny（timer 必须清了）
    await new Promise((r) => setTimeout(r, 100))
    expect(answersFor(engine, 'req-1')).toHaveLength(0)
    // 用户再点 → 已过期
    const { body } = await postJson(app, '/api/v1/sessions/s1/approvals/req-1', { behavior: 'allow' })
    expect(body.code).not.toBe(0)
  })

  it('引擎死了 → 待审批全部取消并广播（不留挂起的 timer）', async () => {
    const { registry, engines, events } = setup({ approvalTimeoutMs: 60_000 })
    const engine = await ensureWithApproval(registry, engines)
    engine.exit(1)
    expect(events.find((e) => e.event === 'approval_resolved')?.data).toMatchObject({
      requestId: 'req-1',
      outcome: 'cancelled',
    })
    expect(engine.answers).toHaveLength(0)
  })
})
