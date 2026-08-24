/**
 * M8：鉴权 —— REST bearer、WS 子协议、启动时序（D6）。
 *
 * 「token 在 listening 之后才读」是同类项目的实战坑：全新机器首次启动
 * 才写 token 文件，提前读会读到空，浏览器直接撞鉴权门。
 * 用「文件启动时不存在」的用例钉住。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { createApp } from '#/server/app.js'
import { startServer } from '#/server/bootstrap.js'

const FIXTURES = fileURLToPath(new URL('../fixtures/sessions', import.meta.url))
const TOKEN = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'

class FakeEngine extends EventEmitter {
  pid = 4242
  async start() {}
  async stop() {}
  send() {}
}

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

describe('REST bearer 鉴权', () => {
  const app = createApp({ projectsRoot: FIXTURES, token: TOKEN })

  it('无 token → 401', async () => {
    const res = await app.request('/api/v1/meta')
    expect(res.status).toBe(401)
  })

  it('错 token → 401', async () => {
    const res = await app.request('/api/v1/meta', {
      headers: { authorization: 'Bearer wrong' },
    })
    expect(res.status).toBe(401)
  })

  it('对 token → 200，信封 code 0', async () => {
    const res = await app.request('/api/v1/meta', {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(res.status).toBe(200)
    expect((await res.json()).code).toBe(0)
  })
})

describe('WS 子协议鉴权', () => {
  async function setupWs() {
    const boot = await startServer({
      projectsRoot: FIXTURES,
      tokenPath: join(mkdtempSync(join(tmpdir(), 'cc-web-ws-')), 'server.token'),
      factory: () => new FakeEngine(),
      port: 0,
    })
    cleanups.push(boot.close)
    return boot
  }

  it('WS 子协议 cc-web.bearer.<token> 能通过', async () => {
    const boot = await setupWs()
    const ws = new WebSocket(
      `ws://127.0.0.1:${boot.port}/api/v1/ws?session=s1`,
      `cc-web.bearer.${boot.token}`,
    )
    cleanups.push(() => ws.close())
    // message 监听必须在 open 之前就挂上 —— state 事件可能紧跟握手到达
    const events: Array<{ event?: string }> = []
    ws.on('message', (data) => events.push(JSON.parse(String(data))))
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('error', reject)
    })
    // 连接后照常收到 state 事件
    const deadline = Date.now() + 3000
    while (!events.some((e) => e.event === 'state')) {
      if (Date.now() > deadline) throw new Error('no state event')
      await new Promise((r) => setTimeout(r, 20))
    }
  })

  it('无子协议 / 错 token → 握手被拒', async () => {
    const boot = await setupWs()
    for (const protocols of [undefined, 'cc-web.bearer.wrong']) {
      const ws = new WebSocket(`ws://127.0.0.1:${boot.port}/api/v1/ws?session=s1`, protocols)
      await expect(
        new Promise((resolve, reject) => {
          ws.on('open', resolve)
          ws.on('error', reject)
        }),
      ).rejects.toThrow()
    }
  })
})

describe('startServer 启动时序（D6）', () => {
  it('token 文件启动时不存在：listening 之后才读/写，返回的 URL 能直接用', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-web-boot-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const boot = await startServer({
      projectsRoot: FIXTURES,
      tokenPath: join(dir, 'server.token'),
      factory: () => new FakeEngine(),
      port: 0,
    })
    cleanups.push(boot.close)

    // URL 用 #token= fragment，不是 ?token=（fragment 不进 access log）
    expect(boot.url).toContain('#token=')
    expect(boot.url).not.toContain('?token=')
    // 默认 host 127.0.0.1（R6：这个服务器能跑 shell，绑 0.0.0.0 等于交出机器）
    expect(boot.url).toContain('127.0.0.1')

    // 首次启动生成的 token 真的在生效：不带 401，带了对的 200
    const unauthorized = await fetch(`http://127.0.0.1:${boot.port}/api/v1/meta`)
    expect(unauthorized.status).toBe(401)
    const authorized = await fetch(`http://127.0.0.1:${boot.port}/api/v1/meta`, {
      headers: { authorization: `Bearer ${boot.token}` },
    })
    expect(authorized.status).toBe(200)
  })
})
