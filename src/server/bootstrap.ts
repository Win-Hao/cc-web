/**
 * M8：服务器组合根 —— 把 app / hub / registry / WS / 鉴权装起来。
 *
 * D6 的时序坑（同类项目实战）：「token 要在 listening 之后才读」，本质是
 * 有些实现的 token 文件由服务器启动过程异步创建，提前读会读到空。
 * 我们的 loadOrCreateToken 是同步的「没有就建」，读任何时刻都成立，
 * 所以选择**先读 token 再 listening** —— 反过来会有未鉴权的监听窗口，
 * 更糟。时序用例（文件启动时不存在）由 test/auth/auth.spec.ts 钉住。
 */
import { EnginePool } from '#/engine/pool.js'
import { createApp } from './app.js'
import { SessionHub } from './hub.js'
import { SessionRegistry } from './registry.js'
import type { EngineFactory } from './registry.js'
import { listenWithFallback } from './listen.js'
import { attachWebSocket } from './ws.js'
import { loadOrCreateToken } from '#/auth/token.js'

export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_PORT = 58630
/** ARCHITECTURE：空闲 N 分钟回收（默认 15），只回收 idle 状态的引擎 */
export const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60_000
const SWEEP_INTERVAL_MS = 60_000

export interface BootstrapDeps {
  projectsRoot: string
  tokenPath: string
  factory: EngineFactory
  host?: string
  port?: number
  idleTimeoutMs?: number
}

export interface BootResult {
  port: number
  host: string
  token: string
  /** 浏览器打开这个：token 走 #fragment，不进 access log（D6） */
  url: string
  close: () => Promise<void>
}

export async function startServer(deps: BootstrapDeps): Promise<BootResult> {
  const host = deps.host ?? DEFAULT_HOST
  const token = loadOrCreateToken(deps.tokenPath)

  const hub = new SessionHub()
  const pool = new EnginePool({ idleTimeoutMs: deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS })
  const registry = new SessionRegistry({ hub, factory: deps.factory, pool })
  const app = createApp({ projectsRoot: deps.projectsRoot, registry, token })

  const held = await listenWithFallback(app, {
    host,
    port: deps.port ?? DEFAULT_PORT,
  })
  attachWebSocket(held.server, { hub, registry, token })

  // 空闲回收循环：sweep 只动「idle 且超时」的引擎，绝不打断在跑/待审批的
  const sweeper = setInterval(() => {
    void pool.sweep()
  }, SWEEP_INTERVAL_MS)
  sweeper.unref()

  return {
    port: held.port,
    host,
    token,
    url: `http://${host}:${held.port}/#token=${token}`,
    close: async () => {
      clearInterval(sweeper)
      await held.close()
    },
  }
}
