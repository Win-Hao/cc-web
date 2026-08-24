/**
 * M1 / D3：引擎进程池 —— 一个会话一个引擎进程，空闲 N 分钟回收。
 *
 * 回收铁律：**只回收 idle 状态的进程**。running / waiting-approval
 * 到点也不许动——回收器本身绝不能成为 R2 的另一种死法。
 *
 * 接线：registry 在 ensure() 时 track（state/lastActivityAt 走 getter），
 * 引擎死亡时 untrack；sweep 由 bootstrap 定时调（默认每分钟一次）。
 */
export type EngineState = 'idle' | 'running' | 'waiting-approval'

/** 池不关心引擎的具体类，只看状态和最后活跃时间。 */
export interface PooledEngine {
  readonly state: EngineState
  readonly lastActivityAt: number
  stop(): Promise<void>
}

export interface EnginePoolOptions {
  idleTimeoutMs: number
  /** 注入时钟，测试用；默认 Date.now */
  now?: () => number
}

export class EnginePool {
  private readonly engines = new Map<string, PooledEngine>()
  private readonly idleTimeoutMs: number
  private readonly now: () => number

  constructor(opts: EnginePoolOptions) {
    this.idleTimeoutMs = opts.idleTimeoutMs
    this.now = opts.now ?? Date.now
  }

  track(id: string, engine: PooledEngine): void {
    this.engines.set(id, engine)
  }

  get(id: string): PooledEngine | undefined {
    return this.engines.get(id)
  }

  /** 从池里移除但不 stop —— 引擎自己死了（registry 的 exit 清理）时用。 */
  untrack(id: string): void {
    this.engines.delete(id)
  }

  /** 回收所有「idle 且空闲超时」的引擎，返回被回收的 id 列表。 */
  async sweep(): Promise<string[]> {
    const reaped: string[] = []
    for (const [id, engine] of this.engines) {
      if (engine.state !== 'idle') continue
      if (this.now() - engine.lastActivityAt <= this.idleTimeoutMs) continue
      await engine.stop()
      this.engines.delete(id)
      reaped.push(id)
    }
    return reaped
  }
}
