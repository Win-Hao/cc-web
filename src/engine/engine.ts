/**
 * D8：Engine —— 协议层，整个项目里唯一认识 CC 帧的地方。
 *
 * 服务器拿到的是四个动作（prompt / interrupt / control / answerApproval）
 * 和六种事件（turn-event / turn-end / approval / approval-cancel / error / exit）；
 * 信封、request_id 配对、initialize 握手、审批去重、fork 的新 id 全关在这里。
 * 帧的事实来源是 test/fixtures/recorded/*（D4），本文件发出的帧结构由
 * 契约测试钉死。
 *
 * 控制请求（M6）：对方回 control_response 才 resolve；每个请求挂超时，
 * 等响应期间引擎死了也 reject —— 任何情况下都不永久挂起。第一个非
 * initialize 的请求会先自动握手（同一进程只握一次，并发共享）。
 *
 * 审批（M7，R5）：can_use_tool 可能从 initialize 响应的
 * pending_permission_requests 和实时帧各来一次 —— 同一 requestId 只
 * emit 一次 approval；对方撤回（control_cancel_request）→ approval-cancel。
 * 超时 / 自动 deny 是策略，不在这里（registry）。
 */
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { EngineProcess } from './process.js'
import type { EngineProcessOptions, EngineTransport, ProcessSpec } from './process.js'
import { ControlRequestError } from './types.js'
import type {
  ApprovalDecision,
  ControlArgs,
  ControlRequest,
  ControlSubtype,
  EngineEvents,
  EngineLike,
  PromptImage,
  TurnEvent,
  TurnResult,
} from './types.js'

export interface ProtocolOptions {
  /** 控制请求超时，默认 10s */
  controlTimeoutMs?: number
  /** request_id 生成器（probe 用固定序号让 fixture 稳定），默认 randomUUID */
  newRequestId?: () => string
}

/** 生产：bin/args 起真进程；测试：注入 transport，不碰进程 */
export type EngineOptions = ProtocolOptions & (EngineProcessOptions | { transport: EngineTransport })

interface PendingControl {
  resolve: (response: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface SessionWaiter {
  resolve: (id: string) => void
  reject: (err: Error) => void
}

export class Engine extends EventEmitter<EngineEvents> implements EngineLike {
  /** 起进程用的 bin/args/cwd（注入 transport 时为 null）；工厂测试和排障用 */
  readonly spec: Readonly<ProcessSpec> | null
  private readonly proc: EngineTransport
  private readonly controlTimeoutMs: number
  private readonly newRequestId: () => string
  private readonly pending = new Map<string, PendingControl>()
  private initializing: Promise<unknown> | null = null
  private initialized = false
  private initResponse: unknown = undefined
  /** 还没答复 / 撤回的审批 requestId：去重用（R5） */
  private readonly openApprovals = new Set<string>()
  private sessionId: string | null = null
  private sessionWaiters: SessionWaiter[] = []
  private exited = false
  /** 最近一次 error（兜底 listener 存：'error' 没人听会 throw 崩进程） */
  lastError: Error | null = null

  constructor(opts: EngineOptions) {
    super()
    if ('transport' in opts) {
      this.proc = opts.transport
      this.spec = null
    } else {
      this.proc = new EngineProcess(opts)
      this.spec = { bin: opts.bin, args: opts.args, ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}) }
    }
    this.controlTimeoutMs = opts.controlTimeoutMs ?? 10_000
    this.newRequestId = opts.newRequestId ?? randomUUID
    this.on('error', (err) => {
      this.lastError = err
    })
    this.proc.on('frame', (frame) => this.route(frame))
    this.proc.on('error', (err) => this.emit('error', err))
    this.proc.on('exit', (code, signal) => this.onExit(code, signal))
  }

  get pid(): number | null {
    return this.proc.pid
  }

  /** stderr 尾部（最多 4KB），诊断用 */
  get stderrTail(): string {
    return this.proc.stderrTail
  }

  start(): Promise<void> {
    return this.proc.start()
  }

  /** 按进程组杀：SIGTERM → 等 close → 超时升级 SIGKILL（process.ts） */
  stop(timeoutMs?: number): Promise<void> {
    return this.proc.stop(timeoutMs)
  }

  /* ── 动作 ─────────────────────────────────────────────── */

  /** 图在前文在后（Messages API 的推荐顺序）；纯图不发空 text 块（PROTOCOL §2） */
  prompt(text: string, images: PromptImage[] = []): void {
    const content: unknown[] = images.map((img) => ({
      type: 'image',
      source: { type: 'base64', media_type: img.media_type, data: img.data },
    }))
    if (text !== '') content.push({ type: 'text', text })
    this.proc.write({ type: 'user', message: { role: 'user', content } })
  }

  /** 中断不等应答：对端的 control_response 到了也只是被忽略 */
  interrupt(): void {
    this.proc.write(controlRequest(this.newRequestId(), { subtype: 'interrupt' }))
  }

  async control<S extends ControlSubtype>(subtype: S, ...[payload]: ControlArgs<S>): Promise<unknown> {
    if (subtype === 'initialize') return this.ensureInitialized()
    await this.ensureInitialized()
    return this.request({ subtype, ...(payload ?? {}) } as ControlRequest)
  }

  /** decision 原样进 control_response（PermissionResult 形状，sdk.d.ts） */
  answerApproval(requestId: string, decision: ApprovalDecision): void {
    this.openApprovals.delete(requestId)
    this.proc.write({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response: decision },
    })
  }

  /**
   * CC 分配的 session id：从首个带顶层 session_id 的帧读（M55 真机实测：
   * spawn 后立即有 system/hook_started 之类的帧带它，不用等 init）。
   */
  awaitSessionId(timeoutMs = 15_000): Promise<string> {
    if (this.sessionId !== null) return Promise.resolve(this.sessionId)
    if (this.exited) return Promise.reject(new Error('engine exited before reporting session id'))
    return new Promise((resolve, reject) => {
      const waiter: SessionWaiter = {
        resolve: (id) => {
          clearTimeout(timer)
          resolve(id)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
      }
      const timer = setTimeout(() => {
        this.sessionWaiters = this.sessionWaiters.filter((w) => w !== waiter)
        reject(new Error('timed out waiting for session id'))
      }, timeoutMs)
      this.sessionWaiters.push(waiter)
    })
  }

  /* ── 控制协议（M6）───────────────────────────────────── */

  /** 幂等握手：同一进程只握一次，并发调用共享同一次 */
  private ensureInitialized(): Promise<unknown> {
    if (this.initialized) return Promise.resolve(this.initResponse)
    if (this.initializing === null) {
      this.initializing = this.request({ subtype: 'initialize' })
        .then((response) => {
          this.initialized = true
          this.initResponse = response
          return response
        })
        .finally(() => {
          this.initializing = null
        })
    }
    return this.initializing
  }

  /** 发一个 control_request 并挂起等匹配的 control_response（超时 / 引擎死都 reject） */
  private request(request: ControlRequest): Promise<unknown> {
    const requestId = this.newRequestId()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new ControlRequestError(`control request timed out: ${request.subtype}`))
      }, this.controlTimeoutMs)
      this.pending.set(requestId, { resolve, reject, timer })
      try {
        this.proc.write(controlRequest(requestId, request))
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(requestId)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  /* ── 帧路由 ──────────────────────────────────────────── */

  private route(frame: unknown): void {
    const f = rec(frame)
    if (f === null) return
    if (typeof f.session_id === 'string' && f.session_id !== '') this.observeSessionId(f.session_id)
    switch (f.type) {
      case 'control_response':
        return this.onControlResponse(f)
      case 'control_request':
        return this.onControlRequest(f)
      case 'control_cancel_request':
        return this.onControlCancel(f)
      case 'keep_alive':
        return // 传输层心跳，不是回合的一部分
      default:
        // 未知类型也透传：上游加帧是常态，归一化层会忽略它不认识的
        this.emit('turn-event', frame as TurnEvent)
        if (f.type === 'result') this.emit('turn-end', frame as TurnResult)
    }
  }

  /** control_response → 等待中的请求。不认识的 request_id（interrupt 的应答、迟到的）忽略 */
  private onControlResponse(f: Record<string, unknown>): void {
    const resp = rec(f.response)
    if (resp === null) return
    // 接入已初始化的会话：响应里可能带还没答复的审批请求（R5）
    if (Array.isArray(resp.pending_permission_requests)) {
      for (const req of resp.pending_permission_requests) {
        const r = rec(req)
        if (r !== null) this.onControlRequest(r)
      }
    }
    if (typeof resp.request_id !== 'string') return
    const p = this.pending.get(resp.request_id)
    if (p === undefined) return
    this.pending.delete(resp.request_id)
    clearTimeout(p.timer)
    if (resp.subtype === 'success') {
      p.resolve(resp.response)
    } else {
      p.reject(new ControlRequestError(typeof resp.error === 'string' ? resp.error : 'control request failed'))
    }
  }

  /**
   * CC → 我们的反向请求。can_use_tool 转 approval（按 requestId 去重）；
   * 其它 subtype（hook_callback / mcp_message / elicitation / request_user_dialog）
   * 我们没登记过对应能力，按协议不答复。
   */
  private onControlRequest(f: Record<string, unknown>): void {
    const request = rec(f.request)
    if (request === null || request.subtype !== 'can_use_tool' || typeof f.request_id !== 'string') return
    if (this.openApprovals.has(f.request_id)) return
    this.openApprovals.add(f.request_id)
    this.emit('approval', {
      requestId: f.request_id,
      tool_name: typeof request.tool_name === 'string' ? request.tool_name : null,
      input: request.input ?? null,
    })
  }

  /** 对方撤回还在飞的请求：停止等待，之后不再答复。没见过的 id 忽略 */
  private onControlCancel(f: Record<string, unknown>): void {
    if (typeof f.request_id !== 'string') return
    if (this.openApprovals.delete(f.request_id)) this.emit('approval-cancel', f.request_id)
  }

  private observeSessionId(id: string): void {
    if (this.sessionId !== null) return
    this.sessionId = id
    for (const w of this.sessionWaiters.splice(0)) w.resolve(id)
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exited = true
    // 等待中的控制请求全部 reject（不永久挂起），握手状态作废
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new ControlRequestError('engine exited while awaiting control_response'))
    }
    this.pending.clear()
    this.initialized = false
    this.initializing = null
    this.openApprovals.clear()
    for (const w of this.sessionWaiters.splice(0)) w.reject(new Error('engine exited before reporting session id'))
    this.emit('exit', code, signal)
  }
}

function controlRequest(requestId: string, request: ControlRequest): unknown {
  return { type: 'control_request', request_id: requestId, request }
}

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}
