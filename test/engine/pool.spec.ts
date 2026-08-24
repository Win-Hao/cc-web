/**
 * M1 / D3：空闲回收 —— 只动 idle 进程。
 *
 * running / waiting-approval 的引擎到点也**不许**回收：
 * 回收器本身绝不能成为 R2 的另一种死法（docs/TDD.md M1）。
 */
import { describe, it, expect, vi } from 'vitest'
import { EnginePool } from '#/engine/pool.js'
import type { EngineState, PooledEngine } from '#/engine/pool.js'

function fakeEngine(state: EngineState, lastActivityAt: number): PooledEngine & {
  stop: ReturnType<typeof vi.fn>
} {
  return { state, lastActivityAt, stop: vi.fn(async () => {}) }
}

function makePool(timeoutMs = 15 * 60 * 1000) {
  let clock = 0
  const pool = new EnginePool({ idleTimeoutMs: timeoutMs, now: () => clock })
  return {
    pool,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

describe('EnginePool 空闲回收', () => {
  it('idle 且空闲超时的进程被回收，并从池里移除', async () => {
    const { pool, advance } = makePool(1000)
    const e = fakeEngine('idle', 0)
    pool.track('s1', e)
    advance(2000)
    const reaped = await pool.sweep()
    expect(e.stop).toHaveBeenCalledOnce()
    expect(reaped).toEqual(['s1'])
    expect(pool.get('s1')).toBeUndefined()
  })

  it('running 的进程到点不被回收', async () => {
    const { pool, advance } = makePool(1000)
    const e = fakeEngine('running', 0)
    pool.track('s1', e)
    advance(999999)
    expect(await pool.sweep()).toEqual([])
    expect(e.stop).not.toHaveBeenCalled()
    expect(pool.get('s1')).toBeDefined()
  })

  it('waiting-approval 的进程到点不被回收（回收它就是 R2 的死法）', async () => {
    const { pool, advance } = makePool(1000)
    const e = fakeEngine('waiting-approval', 0)
    pool.track('s1', e)
    advance(999999)
    expect(await pool.sweep()).toEqual([])
    expect(e.stop).not.toHaveBeenCalled()
  })

  it('idle 但未到点的不回收；多个引擎各自独立判断', async () => {
    const { pool, advance } = makePool(1000)
    const old = fakeEngine('idle', 0)
    const fresh = fakeEngine('idle', 900)
    const busy = fakeEngine('running', 0)
    pool.track('old', old)
    pool.track('fresh', fresh)
    pool.track('busy', busy)
    advance(1500) // old 空闲 1500ms 超线，fresh 只空闲 600ms
    expect(await pool.sweep()).toEqual(['old'])
    expect(old.stop).toHaveBeenCalledOnce()
    expect(fresh.stop).not.toHaveBeenCalled()
    expect(busy.stop).not.toHaveBeenCalled()
  })
})
