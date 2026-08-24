/**
 * M4：SessionHub —— WS 广播的中枢。
 *
 * 断线补发（API.md）：所有事件带 session 级单调递增 seq，
 * 每个 session 留滚动 buffer，重连带 ?since=<seq> 补发缺口。
 * 这条必须有 —— 刷新页面不该丢正在流的半截输出。
 */
import { describe, it, expect, vi } from 'vitest'
import { SessionHub } from '#/server/hub.js'

describe('SessionHub', () => {
  it('事件带 session 级单调递增 seq（不同 session 各自计数）', () => {
    const hub = new SessionHub()
    expect(hub.publish('s1', 'message', { a: 1 }).seq).toBe(1)
    expect(hub.publish('s1', 'message', { b: 2 }).seq).toBe(2)
    expect(hub.publish('s2', 'message', { c: 3 }).seq).toBe(1)
    expect(hub.publish('s1', 'message', { d: 4 }).seq).toBe(3)
  })

  it('订阅者按序收到事件；退订后不再收', () => {
    const hub = new SessionHub()
    const got: number[] = []
    const unsub = hub.subscribe('s1', (e) => got.push(e.seq))
    hub.publish('s1', 'message', {})
    hub.publish('s1', 'message', {})
    unsub()
    hub.publish('s1', 'message', {})
    expect(got).toEqual([1, 2])
  })

  it('多个订阅者都收到（多标签页）', () => {
    const hub = new SessionHub()
    const a = vi.fn()
    const b = vi.fn()
    hub.subscribe('s1', a)
    hub.subscribe('s1', b)
    hub.publish('s1', 'delta', { x: 1 })
    expect(a).toHaveBeenCalledOnce()
    expect(b).toHaveBeenCalledOnce()
  })

  it('replay(since) 补发 seq 大于它的全部事件', () => {
    const hub = new SessionHub()
    hub.publish('s1', 'message', { n: 1 })
    hub.publish('s1', 'message', { n: 2 })
    hub.publish('s1', 'message', { n: 3 })
    const replayed = hub.replay('s1', 1)
    expect(replayed.map((e) => e.seq)).toEqual([2, 3])
    expect(hub.replay('s1', 0)).toHaveLength(3)
    expect(hub.replay('s1', 3)).toEqual([])
    expect(hub.replay('unknown', 0)).toEqual([])
  })

  it('buffer 滚动：超过容量丢最旧的，replay 只能补到还留着的', () => {
    const hub = new SessionHub({ bufferSize: 3 })
    for (let i = 1; i <= 5; i++) hub.publish('s1', 'message', { n: i })
    expect(hub.replay('s1', 0).map((e) => e.seq)).toEqual([3, 4, 5])
  })
})

describe('prune（M16 防泄漏）', () => {
  it('没有订阅者 → 留存和 seq 一起删（seq 从头再来）', () => {
    const hub = new SessionHub()
    hub.publish('s1', 'message', { n: 1 })
    hub.prune('s1')
    expect(hub.replay('s1', 0)).toEqual([])
    expect(hub.publish('s1', 'message', { n: 2 }).seq).toBe(1)
  })

  it('还有订阅者（标签页开着）→ 不删，断线补发还要用', () => {
    const hub = new SessionHub()
    hub.publish('s1', 'message', { n: 1 })
    hub.subscribe('s1', () => {})
    hub.prune('s1')
    expect(hub.replay('s1', 0)).toHaveLength(1)
  })
})
