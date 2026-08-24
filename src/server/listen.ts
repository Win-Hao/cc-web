/**
 * M3：监听，端口被占自动 +1（API.md：默认 58630，被占则 +1 重试）。
 */
import { serve } from '@hono/node-server'
import type { Hono } from 'hono'
import type { AddressInfo } from 'node:net'
import type * as http from 'node:http'

export interface HeldServer {
  port: number
  /**
   * 底层 http.Server（WS upgrade 要挂在这上面）。
   * @hono/node-server 的类型是 http|http2 联合，但我们没传 createServer，
   * 运行时一定是 http1 的 Server。
   */
  server: http.Server
  close: () => Promise<void>
}

function tryListen(app: Hono, host: string, port: number): Promise<HeldServer> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, hostname: host, port })
    server.once('error', reject)
    server.once('listening', () => {
      const addr = server.address() as AddressInfo
      resolve({
        port: addr.port,
        server: server as unknown as http.Server,
        close: () => new Promise<void>((r) => server.close(() => r())),
      })
    })
  })
}

export async function listenWithFallback(
  app: Hono,
  opts: { host: string; port: number; maxTries?: number },
): Promise<HeldServer> {
  const maxTries = opts.maxTries ?? 10
  let lastErr: unknown
  for (let i = 0; i < maxTries; i++) {
    try {
      return await tryListen(app, opts.host, opts.port + i)
    } catch (err) {
      lastErr = err
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err
    }
  }
  throw new Error(
    `no free port in [${opts.port}, ${opts.port + maxTries}): ${String(lastErr)}`,
  )
}
