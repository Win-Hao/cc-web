/**
 * M4：WebSocket 端点。
 *
 * 起真服务器 + 真 WS 客户端测：连接即收 state、引擎事件转发、
 * 多标签页广播、断开不崩也不回收引擎、?since= 断线补发。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { createApp } from '#/server/app.js'
import { listenWithFallback } from '#/server/listen.js'
import type { HeldServer } from '#/server/listen.js'
import { attachWebSocket } from '#/server/ws.js'
import { SessionHub } from '#/server/hub.js'
import { SessionRegistry } from '#/server/registry.js'
import { fakeEngines, waitFor } from '../fixtures/fake-engine.js'
import type { FakeEngine } from '../fixtures/fake-engine.js'

const FIXTURES = fileURLToPath(new URL('../fixtures/sessions', import.meta.url))

interface Ctx {
  held: HeldServer
  registry: SessionRegistry
  engines: Map<string, FakeEngine>
  wsUrl: string
}

async function setup(): Promise<Ctx> {
  const hub = new SessionHub()
  const { factory, engines } = fakeEngines()
  const registry = new SessionRegistry({ hub, factory })
  const app = createApp({ projectsRoot: FIXTURES })
  const held = await listenWithFallback(app, { host: '127.0.0.1', port: 0 })
  attachWebSocket(held.server, { hub, registry })
  return { held, registry, engines, wsUrl: `ws://127.0.0.1:${held.port}/api/v1/ws` }
}

/** 起 s1 的引擎并交出假引擎 */
async function engineFor(ctx: Ctx, id = 's1'): Promise<FakeEngine> {
  await ctx.registry.ensure(id)
  return ctx.engines.get(id)!
}

interface Client {
  ws: WebSocket
  messages: Array<{ seq: number; event: string; data: unknown }>
}

const openClients: WebSocket[] = []
const servers: HeldServer[] = []
afterEach(async () => {
  for (const ws of openClients.splice(0)) ws.close()
  for (const s of servers.splice(0)) await s.close()
})

function connect(wsUrl: string, query = ''): Promise<Client> {
  return new Promise((resolve, reject) => {
    const messages: Client['messages'] = []
    const ws = new WebSocket(`${wsUrl}${query}`)
    openClients.push(ws)
    ws.on('message', (data) => messages.push(JSON.parse(String(data))))
    ws.on('open', () => resolve({ ws, messages }))
    ws.on('error', reject)
  })
}

/** D7 之后 hub 上只有归一化的 message：假引擎得发像样的 assistant 帧 */
function assistantFrame(uuid: string, text: string): Record<string, unknown> {
  return {
    type: 'assistant', uuid, parent_tool_use_id: null, timestamp: '2026-08-25T00:00:00Z',
    message: { id: `msg_${uuid}`, role: 'assistant', model: 'm', content: [{ type: 'text', text }] },
  }
}
const streamEvent = (event: Record<string, unknown>): Record<string, unknown> => ({ type: 'stream_event', parent_tool_use_id: null, event })

describe('WebSocket /api/v1/ws', () => {
  it('连上之后能收到 state 事件', async () => {
    const ctx = await setup()
    servers.push(ctx.held)
    const c = await connect(ctx.wsUrl, '?session=s1')
    await waitFor(() => {
      expect(c.messages[0]?.event).toBe('state')
      expect((c.messages[0]?.data as { state: string }).state).toBe('idle')
    })
  })

  it('引擎的回合事件归一化后推给客户端，带递增 seq', async () => {
    const ctx = await setup()
    servers.push(ctx.held)
    const c = await connect(ctx.wsUrl, '?session=s1')
    const engine = await engineFor(ctx)
    engine.turnEvent(assistantFrame('a1', 'hi'))
    engine.turnEvent(streamEvent({ type: 'message_start', message: { id: 'm2', model: 'm' } }))
    engine.turnEvent(streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
    engine.turnEvent(streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'h' } }))
    await waitFor(() => {
      const events = c.messages.map((m) => m.event)
      expect(events).toContain('message')
      expect(events).toContain('delta')
      const seqs = c.messages.map((m) => m.seq)
      expect([...seqs].sort((a, b) => a - b)).toEqual(seqs)
    })
  })

  it('两个客户端连同一 session，都收到（多标签页）', async () => {
    const ctx = await setup()
    servers.push(ctx.held)
    const c1 = await connect(ctx.wsUrl, '?session=s1')
    const c2 = await connect(ctx.wsUrl, '?session=s1')
    const engine = await engineFor(ctx)
    engine.turnEvent(assistantFrame('a1', 'hi'))
    await waitFor(() => {
      expect(c1.messages.some((m) => m.event === 'message')).toBe(true)
      expect(c2.messages.some((m) => m.event === 'message')).toBe(true)
    })
  })

  it('客户端断开，服务器不崩，其余客户端照收', async () => {
    const ctx = await setup()
    servers.push(ctx.held)
    const c1 = await connect(ctx.wsUrl, '?session=s1')
    const c2 = await connect(ctx.wsUrl, '?session=s1')
    const engine = await engineFor(ctx)
    c1.ws.close()
    await new Promise((r) => setTimeout(r, 50))
    engine.turnEvent(assistantFrame('a2', 'hi')) // 若服务器崩了这条收不到
    await waitFor(() => {
      expect(c2.messages.some((m) => m.event === 'message')).toBe(true)
    })
  })

  it('客户端断开后引擎不被回收（用户可能只是刷新页面）', async () => {
    const ctx = await setup()
    servers.push(ctx.held)
    const engine = await engineFor(ctx)
    const c = await connect(ctx.wsUrl, '?session=s1')
    c.ws.close()
    await new Promise((r) => setTimeout(r, 100))
    expect(engine.stopped).toBe(false)
    expect(ctx.registry.get('s1')).toBe(engine)
  })

  it('断线重连带 ?since=<seq> 补发缺失事件', async () => {
    const ctx = await setup()
    servers.push(ctx.held)
    const c1 = await connect(ctx.wsUrl, '?session=s1')
    const engine = await engineFor(ctx)
    engine.turnEvent(assistantFrame('n1', 'one'))
    // 必须等 n1 真到了再记 seq，否则记到的是 state 事件的 seq（竞态）
    await waitFor(() =>
      expect(c1.messages.some((m) => (m.data as { uuid?: string }).uuid === 'n1')).toBe(true),
    )
    const lastSeq = c1.messages[c1.messages.length - 1]!.seq
    c1.ws.close()

    // 断开期间又出了两条 —— /history 补不上这段（jsonl 落盘有延迟）
    engine.turnEvent(assistantFrame('n2', 'two'))
    engine.turnEvent(assistantFrame('n3', 'three'))

    const c2 = await connect(ctx.wsUrl, `?session=s1&since=${lastSeq}`)
    await waitFor(() => {
      // 补发的是 seq > 0 的留存事件
      const ns = c2.messages
        .filter((m) => m.event === 'message' && m.seq > 0)
        .map((m) => (m.data as { uuid: string }).uuid)
      expect(ns).toEqual(['n2', 'n3'])
      // 回合还没结束（没来 result）：D7 的 snapshot 以 seq 0 把当前回合再给一遍，upsert 幂等
      const snap = c2.messages
        .filter((m) => m.event === 'message' && m.seq === 0)
        .map((m) => (m.data as { uuid: string }).uuid)
      expect(snap).toEqual(['n1', 'n2', 'n3'])
    })
  })
})
