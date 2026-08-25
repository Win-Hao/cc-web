/**
 * M4：WebSocket 端点 /api/v1/ws。
 *
 * 连接时序（利用 server 单线程同步发布，三步之间不会有事件插入）：
 *   1. replay ?since=<seq> 之后的留存事件（断线补发）
 *   2. subscribe —— 之后的 live 事件直接推
 *   3. publish 当前 state —— 新客户端一定能收到，其它标签页也同步
 *   4. 直发当前回合的 snapshot（D7）—— 中途打开的页面也有半截消息
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
      // 带 since = 断线重连：补发缺口。不带 = 新打开的页面：历史走 /history、
      // 进行中的回合走下面的 snapshot，不回放留存（回放会把上一回合再发一遍；
      // message 是 upsert 无所谓，delta 不是）
      const sinceRaw = url.searchParams.get('since')
      if (sinceRaw !== null) {
        const since = Number(sinceRaw)
        for (const e of deps.hub.replay(session, Number.isFinite(since) && since > 0 ? since : 0)) send(ws, e)
      }
      const unsubscribe = deps.hub.subscribe(session, (e) => send(ws, e))
      deps.hub.publish(session, 'state', deps.registry.stateData(session))
      // D7：当前回合的半截消息只给这个连接（seq 0：不进 since 游标）
      for (const m of deps.registry.snapshot(session)) send(ws, { seq: 0, event: 'message', data: m })

      ws.on('close', unsubscribe)
      ws.on('error', unsubscribe)
    })
  })
}
