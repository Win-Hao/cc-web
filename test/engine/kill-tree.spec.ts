/**
 * M1 / R1：按进程组杀 —— 子进程里再 spawn 的孙进程也要一起死。
 *
 * 反直觉点（RISKS R1）：要杀进程组，子进程必须 detached 当 group leader，
 * 然后 kill(-pid)。「不 detach」反而是反模式。
 */
import { describe, it, expect, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import { Engine } from '#/engine/engine.js'

const FAKE = fileURLToPath(new URL('../fixtures/fake-claude.mjs', import.meta.url))

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('Engine 进程组', () => {
  it('stop() 按进程组杀，孙进程也死', async () => {
    const engine = new Engine({
      bin: process.execPath,
      args: [FAKE, '--spawn-sleeper', '--hold'],
    })
    let sleeperPid: number | null = null
    engine.on('message', (m) => {
      const msg = m as { type?: string; pid?: number }
      if (msg.type === 'fake-claude.sleeper') sleeperPid = msg.pid!
    })
    await engine.start()
    await vi.waitFor(() => expect(sleeperPid).not.toBeNull())
    expect(alive(sleeperPid!)).toBe(true)

    await engine.stop()
    await vi.waitFor(() => expect(alive(sleeperPid!)).toBe(false))
  })
})
