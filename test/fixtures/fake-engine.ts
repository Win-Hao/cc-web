/**
 * 假引擎 —— 服务器层测试的唯一引擎替身（D8）。实现 EngineLike：
 * 不碰进程、不碰协议帧，只记录动作、按脚本应答控制请求、按需发事件。
 *
 *   const { factory, engines } = fakeEngines({ auto: { list_models: { models: [] } } })
 *   const fake = engines.get('s1')!
 *   fake.prompts / fake.controls / fake.answers / fake.interrupts   // 断言动作
 *   fake.controls[0]!.resolve({...}) / .reject('msg')               // 手动应答（没 auto 时）
 *   fake.turnEvent(frame) / fake.turnEnd() / fake.approval({...})
 *   fake.cancelApproval(id) / fake.exit() / fake.fail(err)          // 驱动事件
 *
 * 协议层本身（信封、握手、去重）在 test/engine/protocol.spec.ts 里用
 * 真 Engine + 假传输测，这里不再重复。
 */
import { EventEmitter } from 'node:events'
import type {
  ApprovalDecision,
  ApprovalRequest,
  ControlArgs,
  ControlSubtype,
  EngineEvents,
  EngineFactory,
  EngineFactoryOptions,
  EngineLike,
  PromptImage,
  TurnEvent,
  TurnResult,
} from '#/engine/index.js'
import { ControlRequestError } from '#/engine/index.js'

/** auto 表里放它 = 该 subtype 以 error 应答 */
export class FakeControlError {
  constructor(readonly message: string) {}
}

export interface ControlCall {
  subtype: ControlSubtype
  payload: Record<string, unknown> | undefined
  resolve: (response?: unknown) => void
  reject: (message: string) => void
}

export interface FakeEngineOptions {
  /**
   * 自动应答表：subtype → 响应体（或 FakeControlError）。传了表之后
   * 表里没有的 subtype 也以 {} 应答（下一 tick）；不传则全部挂起等手动应答。
   */
  auto?: Partial<Record<ControlSubtype, unknown>>
  /** stop() 之后是否像真引擎一样发 exit（默认 true） */
  exitOnStop?: boolean
  /** awaitSessionId 立即得到的 id（fork 测试用） */
  sessionId?: string
}

export class FakeEngine extends EventEmitter<EngineEvents> implements EngineLike {
  pid = 4242
  started = false
  stopped = false
  prompts: { text: string; images: PromptImage[] }[] = []
  interrupts = 0
  controls: ControlCall[] = []
  answers: { requestId: string; decision: ApprovalDecision }[] = []
  private readonly opts: FakeEngineOptions

  constructor(opts: FakeEngineOptions = {}) {
    super()
    this.opts = opts
    this.on('error', () => {}) // 和真引擎一样：没人听 error 也不崩
  }

  async start(): Promise<void> {
    this.started = true
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.opts.exitOnStop !== false) this.emit('exit', 0, null)
  }

  prompt(text: string, images: PromptImage[] = []): void {
    this.prompts.push({ text, images })
  }

  interrupt(): void {
    this.interrupts += 1
  }

  control<S extends ControlSubtype>(subtype: S, ...[payload]: ControlArgs<S>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const call: ControlCall = {
        subtype,
        payload: payload as Record<string, unknown> | undefined,
        resolve: (response = {}) => resolve(response),
        reject: (message) => reject(new ControlRequestError(message)),
      }
      this.controls.push(call)
      const auto = this.opts.auto
      if (auto === undefined) return
      const canned = auto[subtype] ?? {}
      setImmediate(() => {
        if (canned instanceof FakeControlError) call.reject(canned.message)
        else call.resolve(canned)
      })
    })
  }

  answerApproval(requestId: string, decision: ApprovalDecision): void {
    this.answers.push({ requestId, decision })
  }

  awaitSessionId(): Promise<string> {
    return this.opts.sessionId !== undefined
      ? Promise.resolve(this.opts.sessionId)
      : Promise.reject(new Error('fake engine has no session id'))
  }

  /* ── 驱动事件 ───────────────────────────────────────── */

  /** 一帧回合事件（手写的半截帧也行：归一化层本来就防御性解析） */
  turnEvent(frame: Record<string, unknown>): void {
    this.emit('turn-event', frame as unknown as TurnEvent)
  }

  /** result 帧：先 turn-event 再 turn-end，和真引擎顺序一致 */
  turnEnd(result: Record<string, unknown> = {}): void {
    const frame = { type: 'result', subtype: 'success', ...result } as unknown as TurnResult
    this.emit('turn-event', frame)
    this.emit('turn-end', frame)
  }

  approval(req: { requestId: string; tool_name?: string; input?: unknown }): ApprovalRequest {
    const request: ApprovalRequest = {
      requestId: req.requestId,
      tool_name: req.tool_name ?? 'Bash',
      input: req.input ?? { command: 'ls' },
    }
    this.emit('approval', request)
    return request
  }

  cancelApproval(requestId: string): void {
    this.emit('approval-cancel', requestId)
  }

  exit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.emit('exit', code, signal)
  }

  fail(err: Error): void {
    this.emit('error', err)
  }

  /** 某个 subtype 的调用（断言「发了 / 没发」用） */
  callsOf(subtype: ControlSubtype): ControlCall[] {
    return this.controls.filter((c) => c.subtype === subtype)
  }
}

/** 假引擎工厂 + 登记表：按 session id 拿引擎，按顺序拿工厂调用参数 */
export function fakeEngines(opts: FakeEngineOptions = {}) {
  const engines = new Map<string, FakeEngine>()
  const all: FakeEngine[] = []
  const calls: { id: string; opts: EngineFactoryOptions | undefined }[] = []
  const factory: EngineFactory = (id, o) => {
    const e = new FakeEngine(opts)
    engines.set(id, e)
    all.push(e)
    calls.push({ id, opts: o })
    return e
  }
  return { factory, engines, all, calls }
}

/** 轮询断言直到通过（默认 3s） */
export async function waitFor(assertion: () => void, timeoutMs = 3000): Promise<void> {
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
