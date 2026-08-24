/**
 * M3：端口被占用时自动 +1（API.md：默认 58630，被占则 +1 重试）。
 */
import { describe, it, expect, afterAll } from 'vitest'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { createApp } from '#/server/app.js'
import { listenWithFallback } from '#/server/listen.js'

const FIXTURES = fileURLToPath(new URL('../fixtures/sessions', import.meta.url))

const cleanups: Array<() => Promise<void> | void> = []
afterAll(async () => {
  for (const c of cleanups.reverse()) await c()
})

describe('listenWithFallback', () => {
  it('首选端口空闲时直接用', async () => {
    const app = createApp({ projectsRoot: FIXTURES })
    const held = await listenWithFallback(app, { host: '127.0.0.1', port: 0 })
    cleanups.push(held.close)
    expect(held.port).toBeGreaterThan(0)
    // 真的在听：请求能通
    const res = await fetch(`http://127.0.0.1:${held.port}/api/v1/meta`)
    expect(res.status).toBe(200)
  })

  it('端口被占用时自动 +1', async () => {
    const blocker = createServer()
    blocker.listen(0, '127.0.0.1')
    await once(blocker, 'listening')
    cleanups.push(() => new Promise<void>((r) => blocker.close(() => r())))
    const port = (blocker.address() as AddressInfo).port

    const app = createApp({ projectsRoot: FIXTURES })
    const held = await listenWithFallback(app, { host: '127.0.0.1', port })
    cleanups.push(held.close)
    expect(held.port).toBe(port + 1)
  })
})
