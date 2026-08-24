/**
 * M4/M5/M7：SessionRegistry —— 每个 session 的引擎登记表 + 状态机。
 *
 * 状态：idle / running / waiting-approval。
 *   prompt 发出      → running
 *   result 帧到达    → idle
 *   can_use_tool     → waiting-approval（全部答复/超时/取消后回 running）
 *   引擎退出         → idle（并从表里移除，下次 prompt 重新 spawn）
 * 每次变化 publish 一个 state 事件到 hub，所有标签页同步。
 *
 * 并发策略（R7）：串行化，先拒绝 —— 非 idle 状态的 prompt 直接
 * 抛 SessionBusyError，路由层翻成信封错误码。
 *
 * 控制请求（M6）：set_model / set_permission_mode / list_models 等
 * 走 control()。对 idle 会话会先拉起引擎并 initialize 握手，
 * 握手完成后真正的请求才发出（TDD M6 的核心条款）。每个请求挂
 * 超时，等响应期间引擎死了也 reject —— 任何情况下都不永久挂起。
 *
 * 工具审批（M7，RISKS R2/R5）：can_use_tool 是 CC 反向问我们。
 *   - 不答复引擎就永久挂起 → 每个审批带超时（默认 5 分钟），到点自动 deny
 *   - 同一 requestId 会从 initialize 的 pending_permission_requests 和
 *     实时帧各来一次 → 按 requestId 去重，只弹一次
 *   - 对方可能撤回（control_cancel_request）→ 停止等待，之后不再答复
 *   - 任何终态（allow/deny/timeout/cancelled）都广播 approval_resolved，
 *     所有标签页同步关弹框；已 settle 的再答复 → ApprovalExpiredError
 */
import { randomUUID } from 'node:crypto'
import type { EventEmitter } from 'node:events'
import type { EnginePool } from '#/engine/pool.js'
import { frameToWsEvent } from './normalize.js'
import type { SessionHub } from './hub.js'

export interface EngineLike extends EventEmitter {
  start(): Promise<void>
  stop(): Promise<void>
  /** 写一帧进引擎 stdin；引擎没跑时抛错 */
  send(frame: unknown): void
}

export interface EngineFactoryOptions {
  /** 只在「新建会话」时出现：新会话的工作目录，工厂据此走 --session-id 分支 */
  newSessionCwd?: string
}

export type EngineFactory = (
  sessionId: string,
  opts?: EngineFactoryOptions,
) => EngineLike | Promise<EngineLike>
export type SessionState = 'idle' | 'running' | 'waiting-approval'

export class SessionBusyError extends Error {
  constructor(sessionId: string) {
    super(`session ${sessionId} is busy`)
    this.name = 'SessionBusyError'
  }
}

/** 控制请求失败：对端回了 error 帧 / 超时 / 引擎中途死了 */
export class ControlRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ControlRequestError'
  }
}

interface PendingControl {
  resolve: (response: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** 审批已终结（答复过/超时/取消）或根本不存在 —— 路由层翻成「已过期」 */
export class ApprovalExpiredError extends Error {
  constructor(requestId: string) {
    super(`approval ${requestId} expired or unknown`)
    this.name = 'ApprovalExpiredError'
  }
}

/**
 * 审批决定：PermissionResult 形状（sdk.d.ts）。
 * updatedInput：AskUserQuestion 等交互工具的应答通道 —— allow 时把
 * 用户的选择塞回工具入参（{questions, answers, response?}）。
 */
export type ApprovalDecision =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string }

type ApprovalOutcome = 'allow' | 'deny' | 'timeout' | 'cancelled'

interface ApprovalEntry {
  requestId: string
  settled: boolean
  timer: ReturnType<typeof setTimeout>
}

export class SessionRegistry {
  private readonly engines = new Map<string, EngineLike>()
  private readonly states = new Map<string, SessionState>()
  private readonly pending = new Map<string, Map<string, PendingControl>>()
  private readonly approvals = new Map<string, Map<string, ApprovalEntry>>()
  private readonly initialized = new Set<string>()
  private readonly initializing = new Map<string, Promise<unknown>>()
  private readonly controlTimeoutMs: number
  private readonly approvalTimeoutMs: number
  private readonly hub: SessionHub
  private readonly factory: EngineFactory
  private readonly pool: EnginePool | undefined
  private readonly now: () => number
  /** 每会话最后活跃时间（prompt / 控制请求 / 任意 stdout 帧都算活跃） */
  private readonly lastActivity = new Map<string, number>()

  constructor(deps: {
    hub: SessionHub
    factory: EngineFactory
    controlTimeoutMs?: number
    approvalTimeoutMs?: number
    /** 传了就把引擎登记进空闲回收池（M1 的接线）；sweep 由组合根定时调 */
    pool?: EnginePool
    /** 注入时钟，测试用；默认 Date.now */
    now?: () => number
  }) {
    this.hub = deps.hub
    this.factory = deps.factory
    this.controlTimeoutMs = deps.controlTimeoutMs ?? 10_000
    this.approvalTimeoutMs = deps.approvalTimeoutMs ?? 5 * 60_000
    this.pool = deps.pool
    this.now = deps.now ?? Date.now
  }

  private touch(sessionId: string): void {
    this.lastActivity.set(sessionId, this.now())
  }

  state(sessionId: string): SessionState {
    return this.states.get(sessionId) ?? 'idle'
  }

  private setState(sessionId: string, state: SessionState): void {
    if (this.state(sessionId) === state) return
    this.states.set(sessionId, state)
    this.hub.publish(sessionId, 'state', { state })
  }

  get(sessionId: string): EngineLike | undefined {
    return this.engines.get(sessionId)
  }

  /**
   * 新建会话（M12）：服务器发 uuid，工厂用 --session-id 起全新引擎，
   * cwd 由调用方给。引擎立即登记进表 —— jsonl 要到首条消息才落盘，
   * 这之前的 prompt/控制请求靠这里的登记找到进程。
   */
  async create(cwd: string): Promise<string> {
    const sessionId = randomUUID()
    await this.ensure(sessionId, { newSessionCwd: cwd })
    return sessionId
  }

  /** 同一 session 第二次调用复用同一进程（D3），不重复 spawn。 */
  async ensure(sessionId: string, opts?: EngineFactoryOptions): Promise<EngineLike> {
    const existing = this.engines.get(sessionId)
    if (existing !== undefined) return existing

    const engine = await this.factory(sessionId, opts)
    this.engines.set(sessionId, engine)
    engine.on('message', (frame) => {
      this.touch(sessionId)
      // 控制帧都是 RPC 管道，不是 UI 事件，先进路由：
      // control_response → 等待中的请求；control_request(can_use_tool) → 审批；
      // control_cancel_request → 审批撤回
      if (this.routeControlResponse(sessionId, frame)) return
      if (this.routeControlRequest(sessionId, frame)) return
      if (this.routeControlCancel(sessionId, frame)) return
      const mapped = frameToWsEvent(frame)
      if (mapped !== null) this.hub.publish(sessionId, mapped.event, mapped.data)
      if (isResultFrame(frame)) this.setState(sessionId, 'idle')
    })
    engine.on('error', (err: Error) => {
      this.hub.publish(sessionId, 'error', { message: err.message })
    })
    engine.on('exit', () => {
      // 引擎死了：从表里移除（下次 prompt 重新 spawn），状态归位，
      // 等待中的控制请求全部 reject（不永久挂起），握手状态作废，
      // 待审批的全部取消（清 timer，不泄漏）
      if (this.engines.get(sessionId) === engine) this.engines.delete(sessionId)
      this.pool?.untrack(sessionId) // 引擎已经死了，回收器别再去 stop 尸体
      this.lastActivity.delete(sessionId)
      const bySession = this.pending.get(sessionId)
      if (bySession !== undefined) {
        for (const p of bySession.values()) {
          clearTimeout(p.timer)
          p.reject(new ControlRequestError('engine exited while awaiting control_response'))
        }
        this.pending.delete(sessionId)
      }
      this.cancelAllApprovals(sessionId)
      this.initialized.delete(sessionId)
      this.setState(sessionId, 'idle')
      // 防泄漏（M16）：state 回默认值后表项可删（get 缺省就是 idle）；
      // hub 留存只在没有订阅者时回收（断线补发还要用）
      this.states.delete(sessionId)
      this.hub.prune(sessionId)
    })
    await engine.start()
    this.touch(sessionId)
    // 登记进空闲回收池：state / lastActivityAt 用 getter 反映 registry 实时值，
    // 池只对「idle 且超时」的引擎 stop()（ARCHITECTURE：默认 15 分钟）
    const registry = this
    this.pool?.track(sessionId, {
      get state() {
        return registry.state(sessionId)
      },
      get lastActivityAt() {
        return registry.lastActivity.get(sessionId) ?? 0
      },
      stop: () => engine.stop(),
    })
    return engine
  }

  /**
   * 停掉所有引擎（M16：服务器 close 的一部分）。stop() 走进程组杀，
   * 各引擎的 exit 处理器负责清表/清审批/清池。
   */
  async stopAll(): Promise<void> {
    await Promise.all([...this.engines.values()].map((e) => e.stop()))
  }

  /** 发提示词。非 idle 直接拒绝（R7）。 */
  async prompt(sessionId: string, text: string): Promise<void> {
    if (this.state(sessionId) !== 'idle') throw new SessionBusyError(sessionId)
    // 先同步占住 running 再 await：ensure() 要 spawn 引擎（几百毫秒），
    // 不占位的话并发的第二个 prompt 也会通过上面的 idle 检查（R7 竞态）
    this.setState(sessionId, 'running')
    try {
      const engine = await this.ensure(sessionId)
      engine.send({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
      })
      this.touch(sessionId)
    } catch (err) {
      this.setState(sessionId, 'idle')
      throw err
    }
  }

  /**
   * 中断。会话没在跑（没引擎 / idle）时不报错也不发帧 ——
   * 前端双击中断不该炸出错误（TDD M5）。
   */
  async interrupt(sessionId: string): Promise<void> {
    const engine = this.engines.get(sessionId)
    if (engine === undefined || this.state(sessionId) !== 'running') return
    engine.send({
      type: 'control_request',
      request_id: randomUUID(),
      request: { subtype: 'interrupt' },
    })
  }

  /* ── 控制协议（M6）────────────────────────────────────── */

  /**
   * 发控制请求并等响应。对 idle 会话：先拉起引擎、initialize 握手
   * 完成（幂等，同一引擎只握一次），真正的请求才发出。
   */
  async control(sessionId: string, request: Record<string, unknown>): Promise<unknown> {
    const engine = await this.ensure(sessionId)
    await this.ensureInitialized(sessionId, engine)
    return this.request(sessionId, engine, request)
  }

  async setModel(sessionId: string, model: string): Promise<void> {
    await this.control(sessionId, { subtype: 'set_model', model })
  }

  async setPermissionMode(sessionId: string, mode: string): Promise<void> {
    await this.control(sessionId, { subtype: 'set_permission_mode', mode })
  }

  /**
   * 合并 flag 层设置（M24）。effortLevel 走这里 —— sdk.d.ts：'max' 是
   * 会话级的，只在支持的模型上生效，永不落盘。
   */
  async applyFlagSettings(sessionId: string, settings: Record<string, unknown>): Promise<void> {
    await this.control(sessionId, { subtype: 'apply_flag_settings', settings })
  }

  /** get_settings 的完整 payload（effective/sources/applied，M27）。 */
  async getSettings(sessionId: string): Promise<unknown> {
    return await this.control(sessionId, { subtype: 'get_settings' })
  }

  /** list_models 的 response payload（含 models 数组），失败抛 ControlRequestError */
  async listModels(sessionId: string): Promise<unknown> {
    return await this.control(sessionId, { subtype: 'list_models' })
  }

  /**
   * get_usage 的完整 payload（session 段 + rate_limits 段，PROTOCOL §4）。
   * 拿不到（超时 / 对端 error / 引擎死）→ null，不抛 —— 用量是锦上添花，
   * 绝不能挂（D5/R4）。路由层据此降级或回空。
   */
  async getUsage(sessionId: string): Promise<unknown | null> {
    try {
      return await this.control(sessionId, { subtype: 'get_usage' })
    } catch (err) {
      if (err instanceof ControlRequestError) return null
      throw err
    }
  }

  /**
   * get_context_usage 的 payload（totalTokens/maxTokens/percentage…，M30）。
   * 拿不到 → null，不抛 —— context 环是锦上添花，绝不能挂（D5 同款）。
   */
  async getContextUsage(sessionId: string): Promise<unknown | null> {
    try {
      return await this.control(sessionId, { subtype: 'get_context_usage' })
    } catch (err) {
      if (err instanceof ControlRequestError) return null
      throw err
    }
  }

  private async ensureInitialized(sessionId: string, engine: EngineLike): Promise<void> {
    if (this.initialized.has(sessionId)) return
    // 并发调用共享同一次握手
    let p = this.initializing.get(sessionId)
    if (p === undefined) {
      p = this.request(sessionId, engine, { subtype: 'initialize' })
        .then((response) => {
          this.initialized.add(sessionId)
          // 接入已初始化的会话：响应里可能带还没答复的审批请求（R5），
          // 登记进去 —— 同一 requestId 之后作为实时帧再来会被去重
          this.ingestPendingPermissions(sessionId, response)
        })
        .finally(() => {
          this.initializing.delete(sessionId)
        })
      this.initializing.set(sessionId, p)
    }
    await p
  }

  private ingestPendingPermissions(sessionId: string, response: unknown): void {
    if (typeof response !== 'object' || response === null) return
    const list = (response as Record<string, unknown>).pending_permission_requests
    if (!Array.isArray(list)) return
    for (const frame of list) {
      if (typeof frame !== 'object' || frame === null) continue
      const f = frame as Record<string, unknown>
      const request = f.request as { subtype?: string } | undefined
      if (request?.subtype === 'can_use_tool' && typeof f.request_id === 'string') {
        this.addApproval(sessionId, f.request_id, f)
      }
    }
  }

  /** 发一个 control_request 并挂起等匹配的 control_response（超时/引擎死都 reject） */
  private request(
    sessionId: string,
    engine: EngineLike,
    request: Record<string, unknown>,
  ): Promise<unknown> {
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      let bySession = this.pending.get(sessionId)
      if (bySession === undefined) {
        bySession = new Map()
        this.pending.set(sessionId, bySession)
      }
      const timer = setTimeout(() => {
        bySession.delete(requestId)
        reject(
          new ControlRequestError(
            `control request timed out: ${String(request.subtype ?? '?')}`,
          ),
        )
      }, this.controlTimeoutMs)
      bySession.set(requestId, { resolve, reject, timer })
      try {
        engine.send({ type: 'control_request', request_id: requestId, request })
        this.touch(sessionId)
      } catch (err) {
        clearTimeout(timer)
        bySession.delete(requestId)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  /** 把 control_response 路由给等待中的请求。返回 true = 这帧被消费了。 */
  private routeControlResponse(sessionId: string, frame: unknown): boolean {
    if (typeof frame !== 'object' || frame === null) return false
    const f = frame as Record<string, unknown>
    if (f.type !== 'control_response') return false
    const resp = f.response as
      | { subtype?: string; request_id?: string; response?: unknown; error?: unknown }
      | null
      | undefined
    if (resp === null || resp === undefined || typeof resp.request_id !== 'string') return true
    const p = this.pending.get(sessionId)?.get(resp.request_id)
    if (p !== undefined) {
      this.pending.get(sessionId)!.delete(resp.request_id)
      clearTimeout(p.timer)
      if (resp.subtype === 'success') {
        p.resolve(resp.response)
      } else {
        p.reject(
          new ControlRequestError(
            typeof resp.error === 'string' ? resp.error : 'control request failed',
          ),
        )
      }
    }
    return true
  }

  /* ── 工具审批（M7）────────────────────────────────────── */

  /** CC → 我们的反向请求。can_use_tool 转审批；其它 subtype 暂不支持，原样忽略。 */
  private routeControlRequest(sessionId: string, frame: unknown): boolean {
    if (typeof frame !== 'object' || frame === null) return false
    const f = frame as Record<string, unknown>
    if (f.type !== 'control_request') return false
    const request = f.request as { subtype?: string } | undefined
    if (request?.subtype !== 'can_use_tool') return true
    if (typeof f.request_id !== 'string') return true
    this.addApproval(sessionId, f.request_id, f)
    return true
  }

  /** 对方撤回还在飞的请求：停止等待，之后不再答复。 */
  private routeControlCancel(sessionId: string, frame: unknown): boolean {
    if (typeof frame !== 'object' || frame === null) return false
    const f = frame as Record<string, unknown>
    if (f.type !== 'control_cancel_request' || typeof f.request_id !== 'string') return false
    this.settleApproval(sessionId, f.request_id, 'cancelled')
    return true
  }

  /** 登记审批（按 requestId 去重，R5），广播 approval 事件，挂超时。 */
  private addApproval(sessionId: string, requestId: string, frame: unknown): void {
    let bySession = this.approvals.get(sessionId)
    if (bySession === undefined) {
      bySession = new Map()
      this.approvals.set(sessionId, bySession)
    }
    if (bySession.has(requestId)) return // 去重：pending_permission_requests + 实时帧各来一次

    const request = (frame as { request?: Record<string, unknown> }).request ?? {}
    bySession.set(requestId, {
      requestId,
      settled: false,
      timer: setTimeout(() => {
        // R2：用户关掉浏览器也没人答复 → 自动 deny，引擎不能永久挂起
        this.settleApproval(sessionId, requestId, 'timeout', {
          behavior: 'deny',
          message: 'approval timed out',
        })
      }, this.approvalTimeoutMs),
    })
    this.hub.publish(sessionId, 'approval', {
      requestId,
      tool_name: request.tool_name ?? null,
      input: request.input ?? null,
    })
    this.setState(sessionId, 'waiting-approval')
  }

  /** 答复审批。已 settle / 不存在 → ApprovalExpiredError（「已过期」，不崩）。 */
  answerApproval(sessionId: string, requestId: string, decision: ApprovalDecision): void {
    const entry = this.approvals.get(sessionId)?.get(requestId)
    if (entry === undefined || entry.settled) throw new ApprovalExpiredError(requestId)
    this.settleApproval(sessionId, requestId, decision.behavior, decision)
  }

  /**
   * 终结一个审批：清 timer、（可选）发 control_response 给引擎、
   * 广播 approval_resolved。幂等 —— 已 settle 的直接跳过。
   */
  private settleApproval(
    sessionId: string,
    requestId: string,
    outcome: ApprovalOutcome,
    decision?: ApprovalDecision,
  ): void {
    const bySession = this.approvals.get(sessionId)
    const entry = bySession?.get(requestId)
    if (bySession === undefined || entry === undefined || entry.settled) return

    entry.settled = true
    clearTimeout(entry.timer)
    bySession.delete(requestId)

    // decision 存在才回帧：cancelled 是对方撤回，协议明确「不答复」
    if (decision !== undefined) {
      this.engines.get(sessionId)?.send({
        type: 'control_response',
        response: { subtype: 'success', request_id: requestId, response: decision },
      })
    }
    this.hub.publish(sessionId, 'approval_resolved', { requestId, outcome })
    this.maybeUnwait(sessionId)
  }

  /** 引擎死了：待审批全部取消（引擎都没了，发不出 deny 帧，只清状态广播）。 */
  private cancelAllApprovals(sessionId: string): void {
    const bySession = this.approvals.get(sessionId)
    if (bySession === undefined) return
    for (const requestId of [...bySession.keys()]) {
      this.settleApproval(sessionId, requestId, 'cancelled')
    }
    this.approvals.delete(sessionId)
  }

  /** 没有待审批了就回 running（只在是 waiting-approval 时动）。 */
  private maybeUnwait(sessionId: string): void {
    if (this.state(sessionId) !== 'waiting-approval') return
    if ((this.approvals.get(sessionId)?.size ?? 0) > 0) return
    this.setState(sessionId, 'running')
  }
}

function isResultFrame(frame: unknown): boolean {
  return (
    typeof frame === 'object' &&
    frame !== null &&
    (frame as Record<string, unknown>).type === 'result'
  )
}
