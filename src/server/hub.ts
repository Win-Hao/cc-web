/**
 * M4：SessionHub —— 每个 session 的事件总线。
 *
 * - 事件带 session 级单调递增 seq
 * - 滚动 buffer（默认 200 条）供断线重连 ?since=<seq> 补发
 * - 多订阅者广播（多标签页）
 *
 * 纯内存、同步发布：server 层单线程，replay→subscribe 之间不会有
 * 事件插入，WS 层靠这个保证连接瞬间不丢帧。
 */
export interface HubEvent {
  seq: number
  event: string
  data: unknown
}

export type HubListener = (e: HubEvent) => void

const DEFAULT_BUFFER_SIZE = 200

export class SessionHub {
  private readonly bufferSize: number
  private readonly buffers = new Map<string, HubEvent[]>()
  private readonly listeners = new Map<string, Set<HubListener>>()
  private readonly seqs = new Map<string, number>()

  constructor(opts: { bufferSize?: number } = {}) {
    this.bufferSize = opts.bufferSize ?? DEFAULT_BUFFER_SIZE
  }

  publish(sessionId: string, event: string, data: unknown): HubEvent {
    const seq = (this.seqs.get(sessionId) ?? 0) + 1
    this.seqs.set(sessionId, seq)
    const e: HubEvent = { seq, event, data }

    const buf = this.buffers.get(sessionId) ?? []
    buf.push(e)
    if (buf.length > this.bufferSize) buf.splice(0, buf.length - this.bufferSize)
    this.buffers.set(sessionId, buf)

    for (const l of this.listeners.get(sessionId) ?? []) l(e)
    return e
  }

  /** seq 大于 sinceSeq 的全部留存事件（滚动 buffer 装不下的部分就真丢了） */
  replay(sessionId: string, sinceSeq: number): HubEvent[] {
    return (this.buffers.get(sessionId) ?? []).filter((e) => e.seq > sinceSeq)
  }

  subscribe(sessionId: string, listener: HubListener): () => void {
    let set = this.listeners.get(sessionId)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(sessionId, set)
    }
    set.add(listener)
    return () => {
      set.delete(listener)
    }
  }
}
