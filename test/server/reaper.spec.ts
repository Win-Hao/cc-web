/**
 * M1 接线：EnginePool ↔ SessionRegistry —— 空闲回收真正生效。
 *
 * 池不持有状态，只透过 getter 看 registry 的实时 state 和最后活跃时间
 * （prompt / 控制请求 / 任意回合事件都刷新）。只有「idle 且超时」的
 * 引擎被 stop 并从 registry 移除，下次 prompt 重新 spawn。
 */
import { describe, it, expect } from 'vitest'
import { EnginePool } from '#/engine/pool.js'
import { SessionHub } from '#/server/hub.js'
import { SessionRegistry } from '#/server/registry.js'
import { fakeEngines } from '../fixtures/fake-engine.js'

function setup(idleTimeoutMs = 1000) {
  let clock = 0
  const now = () => clock
  const pool = new EnginePool({ idleTimeoutMs, now })
  const { factory, all: engines } = fakeEngines()
  const registry = new SessionRegistry({ hub: new SessionHub(), factory, pool, now })
  return {
    pool,
    registry,
    engines,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

describe('空闲回收接线（pool ↔ registry）', () => {
  it('idle 超时的引擎被 stop 并从 registry 移除；下次 prompt 重新 spawn', async () => {
    const { pool, registry, engines, advance } = setup(1000)
    await registry.ensure('s1')
    advance(1001)
    expect(await pool.sweep()).toEqual(['s1'])
    expect(engines[0]!.stopped).toBe(true)
    expect(registry.get('s1')).toBeUndefined()
    await registry.prompt('s1', 'again')
    expect(engines).toHaveLength(2)
  })

  it('running 的会话到点也不回收（回收它就是 R2 的另一种死法）', async () => {
    const { pool, registry, engines, advance } = setup(1000)
    await registry.prompt('s1', 'work') // → running
    advance(999999)
    expect(await pool.sweep()).toEqual([])
    expect(engines[0]!.stopped).toBe(false)
  })

  it('回合事件刷新活跃时间，回收计时从最后一帧重新算', async () => {
    const { pool, registry, engines, advance } = setup(1000)
    await registry.ensure('s1')
    advance(800)
    engines[0]!.turnEvent({ type: 'system' }) // 有输出 → 活跃
    advance(800) // 距最后活跃只有 800ms，不到线
    expect(await pool.sweep()).toEqual([])
    advance(300) // 距最后活跃 1100ms，超线
    expect(await pool.sweep()).toEqual(['s1'])
  })

  it('引擎自己死了会从池里移除，sweep 不会再去 stop 尸体', async () => {
    const { pool, registry, engines, advance } = setup(1000)
    await registry.ensure('s1')
    engines[0]!.exit(1) // 引擎意外死亡
    advance(999999)
    expect(await pool.sweep()).toEqual([])
    expect(engines[0]!.stopped).toBe(false)
  })
})
