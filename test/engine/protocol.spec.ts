/**
 * D8：协议层 —— 信封、request_id 配对、initialize 握手、审批去重 / 撤回、
 * fork 的新 id。用假传输（不起进程）喂帧。
 *
 * 帧的事实来源是录制的真实帧（test/fixtures/recorded/control.*，D4）：
 * 我们发出的帧要和录到的 sent 完全一致，录到的响应要能各归其主。
 */
import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ControlRequestError, Engine } from '#/engine/index.js'
import type { ApprovalRequest, EngineTransport, TransportEvents } from '#/engine/index.js'

const RECORDED = fileURLToPath(new URL('../fixtures/recorded/', import.meta.url))

class FakeTransport extends EventEmitter<TransportEvents> implements EngineTransport {
  written: Record<string, unknown>[] = []
  pid = 4242
  stderrTail = ''
  closed = false
  async start() {}
  async stop() {
    this.closed = true
    this.emit('exit', 0, null)
  }
  write(frame: unknown) {
    if (this.closed) throw new Error('engine is not running')
    this.written.push(frame as Record<string, unknown>)
  }
  frame(f: unknown) {
    this.emit('frame', f)
  }
  /** 对第 i 个发出的帧（必须是 control_request）回成功应答 */
  respond(i: number, response?: unknown) {
    this.frame({
      type: 'control_response',
      response: { subtype: 'success', request_id: this.written[i]!.request_id, ...(response !== undefined ? { response } : {}) },
    })
  }
  respondError(i: number, error: string) {
    this.frame({ type: 'control_response', response: { subtype: 'error', request_id: this.written[i]!.request_id, error } })
  }
}

function setup(opts: { controlTimeoutMs?: number } = {}) {
  const t = new FakeTransport()
  let n = 0
  const engine = new Engine({ transport: t, newRequestId: () => `probe-${n++}`, ...opts })
  return { t, engine }
}

const recordedSent = (name: string): Record<string, unknown>[] =>
  (JSON.parse(readFileSync(`${RECORDED}${name}.meta.json`, 'utf8')) as { sent: string[] }).sent.map(
    (s) => JSON.parse(s) as Record<string, unknown>,
  )
const recordedFrames = (name: string): Record<string, unknown>[] =>
  readFileSync(`${RECORDED}${name}.ndjson`, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>)

const subtypes = (t: FakeTransport) => t.written.map((w) => (w.request as { subtype: string }).subtype)
const flush = () => new Promise((r) => setImmediate(r))
const canUseTool = (requestId: string, toolName = 'Bash') => ({
  type: 'control_request',
  request_id: requestId,
  request: { subtype: 'can_use_tool', tool_name: toolName, input: { command: 'ls' } },
})

describe('prompt / interrupt 的信封', () => {
  it('prompt(text) → user 帧，与录制的 sent 完全一致（契约钉死）', () => {
    const { t, engine } = setup()
    engine.prompt('Reply with exactly: hi')
    expect(t.written).toEqual([recordedSent('simple-turn')[0]])
  })

  it('prompt 带图片：image 块在前 text 在后；纯图不发空 text 块（M43）', () => {
    const { t, engine } = setup()
    engine.prompt('这是什么', [{ media_type: 'image/png', data: 'aGVsbG8=' }])
    engine.prompt('', [{ media_type: 'image/jpeg', data: 'aGVsbG8=' }])
    const content = (i: number) => (t.written[i]!.message as { content: unknown[] }).content
    expect(content(0)).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
      { type: 'text', text: '这是什么' },
    ])
    expect(content(1)).toEqual([{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'aGVsbG8=' } }])
  })

  it('interrupt() → control_request{interrupt}，不等应答；迟到的应答被忽略', () => {
    const { t, engine } = setup()
    engine.interrupt()
    expect(t.written[0]).toEqual({ type: 'control_request', request_id: 'probe-0', request: { subtype: 'interrupt' } })
    expect(() => t.respond(0)).not.toThrow()
  })

  it('引擎没跑时 prompt 直接抛「engine is not running」', () => {
    const { t, engine } = setup()
    t.closed = true
    expect(() => engine.prompt('x')).toThrow(/not running/)
  })
})

describe('控制请求的 initialize 门控（M6）', () => {
  it('第一个控制请求先握手，握手完成后真正的请求才发出', async () => {
    const { t, engine } = setup()
    const p = engine.control('set_model', { model: 'claude-sonnet-5' })
    await flush()
    expect(subtypes(t)).toEqual(['initialize'])
    await new Promise((r) => setTimeout(r, 30))
    expect(subtypes(t)).toEqual(['initialize']) // 没回之前不许发
    t.respond(0, { pid: 1 })
    await flush()
    expect(subtypes(t)).toEqual(['initialize', 'set_model'])
    t.respond(1)
    await expect(p).resolves.toBeUndefined() // set_model 成功没有 payload
  })

  it('同一引擎只握一次；并发调用共享同一次握手', async () => {
    const { t, engine } = setup()
    const p1 = engine.control('list_models')
    const p2 = engine.control('get_settings')
    await flush()
    expect(subtypes(t)).toEqual(['initialize'])
    t.respond(0, {})
    await flush()
    expect(subtypes(t)).toEqual(['initialize', 'list_models', 'get_settings'])
    t.respond(1, { models: [] })
    t.respond(2, { applied: {} })
    await expect(p1).resolves.toEqual({ models: [] })
    await expect(p2).resolves.toEqual({ applied: {} })

    const p3 = engine.control('get_usage')
    await flush()
    expect(subtypes(t).filter((s) => s === 'initialize')).toHaveLength(1)
    t.respond(3, {})
    await p3
  })

  it('显式 control(initialize)：返回响应，之后不再重复握手', async () => {
    const { t, engine } = setup()
    const p = engine.control('initialize')
    await flush()
    t.respond(0, { commands: [] })
    await expect(p).resolves.toEqual({ commands: [] })
    const p2 = engine.control('list_models')
    await flush()
    expect(subtypes(t)).toEqual(['initialize', 'list_models'])
    t.respond(1, { models: [] })
    await p2
  })

  it('发出的三帧与录制的真实帧完全一致（initialize / list_models / set_model）', async () => {
    const { t, engine } = setup()
    const p1 = engine.control('list_models')
    await flush()
    t.respond(0, {})
    await flush()
    t.respond(1, { models: [] })
    await p1
    const p2 = engine.control('set_model', { model: 'claude-sonnet-5' })
    await flush()
    t.respond(2)
    await p2
    expect(t.written).toEqual(recordedSent('control'))
  })
})

describe('控制响应', () => {
  it('error 应答 → reject ControlRequestError，带对端的 message', async () => {
    const { t, engine } = setup()
    const p = engine.control('set_model', { model: 'bad' })
    await flush()
    t.respond(0)
    await flush()
    t.respondError(1, 'unknown model')
    await expect(p).rejects.toThrow(ControlRequestError)
    await expect(p).rejects.toThrow('unknown model')
  })

  it('超时 → reject，不永久挂起', async () => {
    const { engine } = setup({ controlTimeoutMs: 30 })
    await expect(engine.control('list_models')).rejects.toThrow(/timed out: initialize/)
  })

  it('等待响应期间引擎退出 → reject', async () => {
    const { t, engine } = setup()
    const p = engine.control('list_models')
    await flush()
    t.emit('exit', 1, null)
    await expect(p).rejects.toThrow(/exited/)
  })

  it('不认识的 request_id / 坏形状的应答 → 忽略，不崩', () => {
    const { t } = setup()
    expect(() => {
      t.frame({ type: 'control_response', response: { subtype: 'success', request_id: 'nope' } })
      t.frame({ type: 'control_response' })
      t.frame({ type: 'control_response', response: 'garbage' })
    }).not.toThrow()
  })

  it('录制的 control.ndjson 回放：三个响应按 request_id 各归其主，其余帧透传为 turn-event', async () => {
    const { t, engine } = setup()
    const events: string[] = []
    engine.on('turn-event', (ev) => events.push(ev.type))
    const all = recordedFrames('control')
    const isResponseFor = (f: Record<string, unknown>, id: string) =>
      f.type === 'control_response' && (f.response as { request_id?: string }).request_id === id
    const cut = all.findIndex((f) => isResponseFor(f, 'probe-1'))

    const list = engine.control('list_models')
    for (const f of all.slice(0, cut + 1)) {
      t.frame(f)
      await flush()
    }
    expect(((await list) as { models: { value: string }[] }).models[0]!.value).toBe('default')

    const set = engine.control('set_model', { model: 'claude-sonnet-5' })
    await flush()
    for (const f of all.slice(cut + 1)) {
      t.frame(f)
      await flush()
    }
    await expect(set).resolves.toBeUndefined()
    expect(subtypes(t)).toEqual(['initialize', 'list_models', 'set_model'])
    expect(events).toHaveLength(all.filter((f) => f.type !== 'control_response').length)
    expect(events).not.toContain('control_response')
  })
})

describe('帧路由', () => {
  it('非控制帧 → turn-event；result 额外发 turn-end（先 turn-event 后 turn-end）', () => {
    const { t, engine } = setup()
    const order: string[] = []
    engine.on('turn-event', (ev) => order.push(`event:${ev.type}`))
    engine.on('turn-end', (r) => order.push(`end:${r.subtype}`))
    const all = recordedFrames('simple-turn')
    for (const f of all) t.frame(f)
    expect(order.filter((o) => o.startsWith('event:'))).toHaveLength(all.length)
    expect(order.slice(-2)).toEqual(['event:result', 'end:success'])
  })

  it('不认识的类型也透传（上游加帧是常态）；keep_alive 和非对象帧不透传', () => {
    const { t, engine } = setup()
    const seen: unknown[] = []
    engine.on('turn-event', (ev) => seen.push(ev))
    t.frame({ type: 'fake-claude.sleeper', pid: 1 })
    t.frame({ type: 'keep_alive' })
    t.frame(42)
    t.frame('x')
    expect(seen).toEqual([{ type: 'fake-claude.sleeper', pid: 1 }])
  })
})

describe('审批（M7 / R5）', () => {
  it('can_use_tool → approval{requestId, tool_name, input}', () => {
    const { t, engine } = setup()
    const got: ApprovalRequest[] = []
    engine.on('approval', (r) => got.push(r))
    t.frame(canUseTool('req-1'))
    expect(got).toEqual([{ requestId: 'req-1', tool_name: 'Bash', input: { command: 'ls' } }])
  })

  it('同一 requestId 从 initialize 的 pending_permission_requests 和实时帧各来一次 → 只 emit 一次', async () => {
    const { t, engine } = setup()
    const got: string[] = []
    engine.on('approval', (r) => got.push(r.requestId))
    const p = engine.control('list_models')
    await flush()
    t.respond(0, { pending_permission_requests: [canUseTool('req-dup')] })
    await flush()
    t.frame(canUseTool('req-dup'))
    t.respond(1, { models: [] })
    await p
    expect(got).toEqual(['req-dup'])
  })

  it('answerApproval → control_response{success, request_id, response: decision}；答复后同 id 再来算新审批', () => {
    const { t, engine } = setup()
    const got: string[] = []
    engine.on('approval', (r) => got.push(r.requestId))
    t.frame(canUseTool('req-1'))
    engine.answerApproval('req-1', { behavior: 'deny', message: '不许' })
    expect(t.written).toEqual([
      { type: 'control_response', response: { subtype: 'success', request_id: 'req-1', response: { behavior: 'deny', message: '不许' } } },
    ])
    t.frame(canUseTool('req-1'))
    expect(got).toEqual(['req-1', 'req-1'])
  })

  it('control_cancel_request → approval-cancel（只对还在飞的；没见过 / 已答复的 id 忽略）', () => {
    const { t, engine } = setup()
    const cancelled: string[] = []
    engine.on('approval-cancel', (id) => cancelled.push(id))
    t.frame(canUseTool('req-1'))
    t.frame(canUseTool('req-2'))
    engine.answerApproval('req-2', { behavior: 'allow' })
    t.frame({ type: 'control_cancel_request', request_id: 'req-1' })
    t.frame({ type: 'control_cancel_request', request_id: 'req-1' })
    t.frame({ type: 'control_cancel_request', request_id: 'req-2' })
    t.frame({ type: 'control_cancel_request', request_id: 'never' })
    expect(cancelled).toEqual(['req-1'])
  })

  it('其它反向请求（hook_callback 等）不转审批、不答复', () => {
    const { t, engine } = setup()
    let approvals = 0
    engine.on('approval', () => approvals++)
    t.frame({ type: 'control_request', request_id: 'h1', request: { subtype: 'hook_callback', callback_id: 'x', input: {} } })
    expect(approvals).toBe(0)
    expect(t.written).toEqual([])
  })
})

describe('awaitSessionId（M55 fork：新 id 从首帧读）', () => {
  it('首个带 session_id 的帧到达之前 / 之后调用都能拿到', async () => {
    const { t, engine } = setup()
    const early = engine.awaitSessionId(1000)
    t.frame({ type: 'system', subtype: 'hook_started' }) // 没有 session_id 的帧不算
    t.frame({ type: 'system', subtype: 'hook_started', session_id: 'sid-1' })
    t.frame({ type: 'system', subtype: 'init', session_id: 'sid-2' }) // 只认第一个
    await expect(early).resolves.toBe('sid-1')
    await expect(engine.awaitSessionId()).resolves.toBe('sid-1')
  })

  it('引擎退出 → reject；超时 → reject', async () => {
    const a = setup()
    const p = a.engine.awaitSessionId(1000)
    a.t.emit('exit', 1, null)
    await expect(p).rejects.toThrow(/exited/)
    await expect(a.engine.awaitSessionId()).rejects.toThrow(/exited/)
    const b = setup()
    await expect(b.engine.awaitSessionId(20)).rejects.toThrow(/timed out/)
  })
})
