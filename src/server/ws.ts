/**
 * M4：WebSocket 端点 /api/v1/ws。
 *
 * 连接时序（利用 server 单线程同步发布，三步之间不会有事件插入）：
 *   1. replay ?since=<seq> 之后的留存事件（断线补发）
 *   2. subscribe —— 之后的 live 事件直接推
 *   3. publish 当前 state —— 新客户端一定能收到，其它标签页也同步
 *
 * 鉴权（子协议 cc-web.bearer.<token>）在 M8 加，现在只认连接形状。
 */
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import type { Server } from 'node:http'
import type { SessionHub, HubEvent } from './hub.js'
import type { SessionRegistry } from './registry.js'

export interface WsDeps {
  hub: SessionHub
  registry: SessionRegistry
  /** M8：传了就要求子协议 cc-web.bearer.<token>（浏览器不能自定义头，API.md） */
  token?: string
}

const PROTOCOL_PREFIX = 'cc-web.bearer.'

function send(ws: WebSocket, e: HubEvent): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(e))
}

function rejectUpgrade(socket: import('node:stream').Duplex): void {
  socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
  socket.destroy()
}

export function attachWebSocket(server: Server, deps: WsDeps): void {
  const wss = new WebSocketServer({
    noServer: true,
    // 选中客户端提供的 cc-web.bearer.* 子协议，否则握手失败
    handleProtocols: (protocols) => {
      for (const p of protocols) if (p.startsWith(PROTOCOL_PREFIX)) return p
      return false
    },
  })

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '', 'http://127.0.0.1')
    const session = url.searchParams.get('session')
    if (url.pathname !== '/api/v1/ws' || session === null || session === '') {
      socket.destroy()
      return
    }
    if (deps.token !== undefined) {
      const header = req.headers['sec-websocket-protocol'] ?? ''
      const offered = header.split(',').map((p) => p.trim())
      if (!offered.includes(`${PROTOCOL_PREFIX}${deps.token}`)) {
        rejectUpgrade(socket)
        return
      }
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const sinceRaw = Number(url.searchParams.get('since') ?? '0')
      const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? sinceRaw : 0

      for (const e of deps.hub.replay(session, since)) send(ws, e)
      const unsubscribe = deps.hub.subscribe(session, (e) => send(ws, e))
      deps.hub.publish(session, 'state', { state: deps.registry.state(session) })

      ws.on('close', unsubscribe)
      ws.on('error', unsubscribe)
    })
  })
}
