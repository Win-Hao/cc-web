/**
 * M41：失败分类 —— stderr 尾巴 → 用户能行动的信息。
 */
import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { diagnoseEngineFailure } from '#/engine/diagnose.js'
import { SessionHub } from '#/server/hub.js'
import type { HubEvent } from '#/server/hub.js'
import { SessionRegistry } from '#/server/registry.js'

describe('diagnoseEngineFailure', () => {
  it.each([
    ['engine exited unexpectedly: code=1\nstderr: Invalid API key · Please run /login', 'AUTH_REQUIRED', false],
    ['stderr: 429 too many requests', 'RATE_LIMITED', true],
    ['fetch failed: ECONNRESET', 'CONNECTION_DROPPED', true],
    ['spawn claude ENOENT', 'BINARY_NOT_FOUND', false],
  ] as const)('%s → %s', (text, code, retryable) => {
    const diag = diagnoseEngineFailure(text)!
    expect(diag.code).toBe(code)
    expect(diag.retryable).toBe(retryable)
  })

  it('分类不了 → null（调用方裸转原文）', () => {
    expect(diagnoseEngineFailure('engine exited unexpectedly: code=137 signal=SIGKILL')).toBeNull()
  })
})

describe('registry 的 error 事件带分类', () => {
  it('auth 类失败：hub error 事件第一行是人话 + code/retryable', async () => {
    class FakeEngine extends EventEmitter {
      async start() {}
      async stop() {}
      send() {}
    }
    const hub = new SessionHub()
    const events: HubEvent[] = []
    hub.subscribe('s1', (e) => events.push(e))
    const registry = new SessionRegistry({ hub, factory: () => new FakeEngine() })
    const engine = (await registry.ensure('s1')) as FakeEngine
    engine.emit('error', new Error('engine exited unexpectedly: code=1\nstderr: not logged in'))
    const err = events.find((e) => e.event === 'error')!
    const data = err.data as { message: string; code: string; retryable: boolean }
    expect(data.code).toBe('AUTH_REQUIRED')
    expect(data.message).toMatch(/^登录态失效/)
    expect(data.message).toContain('not logged in') // 原文保留
    expect(data.retryable).toBe(false)
  })
})
