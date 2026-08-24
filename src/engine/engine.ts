/**
 * M1：引擎 —— 整个项目里唯一跟 CC 进程打交道的地方（D1）。
 *
 * 生命周期三条铁律（RISKS R1）：
 *   1. spawn 时 `detached: true`，子进程当进程组组长 —— 这样才能
 *      `kill(-pid)` 按组杀，孙进程（CC 自己 spawn 的东西）才不会漏。
 *      「不 detach」在这里是反模式。
 *   2. stop() 按进程组杀，SIGTERM 之后不死的升级 SIGKILL。
 *   3. 服务器进程退出路径全挂清理（exit / SIGINT / SIGTERM），
 *      子进程跟服务器同生共死，绝不 spawn 完就放手。
 *
 * 可测性前提（TDD M0）：bin/args 必须注入，引擎自己不知道
 * 「真实 claude 在哪」。
 *
 * 事件：
 *   'message'  stdout 的每一帧 NDJSON（已 JSON.parse）
 *   'error'    spawn 失败 / 意外退出（非 0 且不是 stop() 杀的）/ 坏帧。
 *              引擎内置兜底 listener 把错误存进 lastError —— EventEmitter
 *              的 'error' 没人听会 throw 崩进程，那样比静默更糟。
 *   'exit'     进程 close（code, signal），正常死亡和被杀都会发
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { NdjsonParser } from './ndjson.js'

export interface EngineOptions {
  bin: string
  args: string[]
  /** resume 时必须设成会话原 cwd（从 jsonl 行读，D3），否则 CLAUDE.md 全错 */
  cwd?: string
}

export class Engine extends EventEmitter {
  private child: ChildProcess | null = null
  private stopping = false
  private readonly parser: NdjsonParser
  private readonly opts: EngineOptions
  /** 最近一次 error（兜底 listener 存，见类注释） */
  lastError: Error | null = null
  /** stderr 尾部环形缓冲（M40）：意外死亡时拼进错误信息，排障用 */
  private stderrBuf = ''

  constructor(opts: EngineOptions) {
    super()
    this.opts = opts
    this.parser = new NdjsonParser({
      onMessage: (m) => this.emit('message', m),
      onError: (err, raw) =>
        this.emitError(new Error(`bad NDJSON frame: ${err.message} (raw: ${raw.slice(0, 200)})`)),
    })
    this.on('error', (err: Error) => {
      this.lastError = err
    })
  }

  get pid(): number | null {
    return this.child?.pid ?? null
  }

  /** stderr 尾部（最多 4KB），诊断用 */
  get stderrTail(): string {
    return this.stderrBuf
  }

  /** spawn 成功（'spawn' 事件）后 resolve；spawn 失败 reject 且 emit error。 */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.opts.bin, this.opts.args, {
        ...(this.opts.cwd !== undefined ? { cwd: this.opts.cwd } : {}),
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      this.child = child
      registerForCleanup(this)

      child.once('error', (err) => {
        this.emitError(err)
        reject(err)
      })
      child.once('spawn', () => resolve())

      // EPIPE 守卫（M38）：快速退出的 CLI（坏登录态、
      // 模型不存在）会让 stdin 写入变成未处理的 stream error，直接崩掉
      // 服务器进程。EPIPE/已销毁 属于「进程正在死」，close 处理器会报；
      // 其它错误走正常 error 通道（内置兜底 listener 保证不裸抛）。
      child.stdin!.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code !== 'EPIPE' && err.code !== 'ERR_STREAM_DESTROYED') this.emitError(err)
      })

      // setEncoding 让 Node 的 StringDecoder 处理跨 chunk 的 UTF-8 多字节
      // 字符 —— 逐 chunk 各自 toString 会把劈开的汉字解码成替换符（乱码）
      child.stdout!.setEncoding('utf8')
      child.stdout!.on('data', (c: string) => this.parser.push(c))
      // stderr 必须读掉（不读会把管道写满阻塞子进程），同时留尾部 4KB：
      // 引擎意外死亡时 code=1 本身毫无信息量，stderr 尾巴才是死因（M40）
      child.stderr!.setEncoding('utf8')
      child.stderr!.on('data', (c: string) => {
        this.stderrBuf = (this.stderrBuf + c).slice(-4096)
      })

      child.on('close', (code, signal) => {
        unregisterForCleanup(this)
        this.parser.end()
        if (!this.stopping && code !== 0) {
          const tail = this.stderrBuf.trim().slice(-500)
          this.emitError(
            new Error(
              `engine exited unexpectedly: code=${code} signal=${signal}` +
                (tail !== '' ? `\nstderr: ${tail}` : ''),
            ),
          )
        }
        this.emit('exit', code, signal)
      })
    })
  }

  /**
   * 写一帧进引擎 stdin（user 消息 / control_request 都是这条路）。
   * 引擎没在跑时调用直接抛 —— 调用方（registry）负责先 ensure。
   */
  send(frame: unknown): void {
    const stdin = this.child?.stdin
    if (stdin === null || stdin === undefined || !stdin.writable) {
      throw new Error('engine is not running')
    }
    try {
      stdin.write(JSON.stringify(frame) + '\n')
    } catch {
      // writable 检查和写入之间的竞态窗口：进程刚好死了 → 统一成
      // 「没在跑」错误，调用方（registry）已有处理路径
      throw new Error('engine is not running')
    }
  }

  /**
   * 按进程组杀：SIGTERM → 等 close → 超时升级 SIGKILL。
   * stop() 导致的退出不 emit error（这是正常死亡）。
   */
  async stop(timeoutMs = 5000): Promise<void> {
    const child = this.child
    // exitCode 只覆盖正常退出；被信号杀死的进程 exitCode 是 null、
    // signalCode 才有值 —— 漏了它会去等一个永不再发的 close，挂死
    if (child === null || child.exitCode !== null || child.signalCode !== null) return
    this.stopping = true
    const closed = new Promise<void>((r) => child.once('close', () => r()))
    this.killGroup('SIGTERM')
    const timedOut = await Promise.race([
      closed.then(() => false),
      new Promise<true>((r) => setTimeout(() => r(true), timeoutMs)),
    ])
    if (timedOut) {
      this.killGroup('SIGKILL')
      await closed
    }
  }

  /** 同步杀进程组 —— 'exit' 钩子里不能 await，只能用它。 */
  killGroupSync(): void {
    this.killGroup('SIGTERM')
  }

  private killGroup(signal: NodeJS.Signals): void {
    const pid = this.child?.pid
    if (pid === undefined) return
    try {
      process.kill(-pid, signal)
    } catch {
      // ESRCH = 进程组已经没了，正是我们想要的状态
    }
  }

  private emitError(err: Error): void {
    this.emit('error', err)
  }
}

/* ── 服务器退出清理（R1：退出路径全挂）──────────────────────────
 * 模块级注册一次，所有活着的引擎共享。'exit' 事件里不能异步，
 * 所以只能同步 kill；SIGINT/SIGTERM 挂了 handler 后默认退出行为
 * 消失，必须清理完显式 process.exit。
 */
const liveEngines = new Set<Engine>()
let hooksInstalled = false

function killAllLive(): void {
  for (const e of liveEngines) e.killGroupSync()
}

function registerForCleanup(e: Engine): void {
  liveEngines.add(e)
  if (hooksInstalled) return
  hooksInstalled = true
  process.once('exit', killAllLive)
  process.on('SIGINT', () => {
    killAllLive()
    process.exit(130)
  })
  process.on('SIGTERM', () => {
    killAllLive()
    process.exit(143)
  })
}

function unregisterForCleanup(e: Engine): void {
  liveEngines.delete(e)
}
