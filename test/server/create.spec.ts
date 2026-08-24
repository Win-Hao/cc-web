/**
 * M12：新建会话 —— POST /api/v1/sessions。
 *
 * 服务器发 uuid，工厂拿到 newSessionCwd 走 --session-id 分支；
 * 引擎立即登记（jsonl 落盘前 prompt/history 都得能用）。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hono } from 'hono'
import { createApp } from '#/server/app.js'
import { SessionHub } from '#/server/hub.js'
import { SessionRegistry } from '#/server/registry.js'
import type { EngineFactoryOptions } from '#/server/registry.js'

class FakeEngine extends EventEmitter {
  sent: unknown[] = []
  async start() {}
  async stop() {}
  send(frame: unknown) {
    this.sent.push(frame)
  }
}

const tmpdirs: string[] = []
afterEach(() => {
  for (const d of tmpdirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'cc-web-create-'))
  tmpdirs.push(dir)
  const hub = new SessionHub()
  const calls: { id: string; opts: EngineFactoryOptions | undefined }[] = []
  const engines = new Map<string, FakeEngine>()
  const registry = new SessionRegistry({
    hub,
    factory: (id, opts) => {
      calls.push({ id, opts })
      const e = new FakeEngine()
      engines.set(id, e)
      return e
    },
  })
  const app = createApp({ projectsRoot: dir, registry })
  return { app, registry, calls, engines, dir }
}

async function postJson(app: Hono, path: string, body: unknown) {
  const res = await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

describe('POST /api/v1/sessions（新建会话）', () => {
  it('回服务器发的 uuid；工厂拿到 newSessionCwd（--session-id 分支的依据）', async () => {
    const { app, calls, dir } = setup()
    const { body } = await postJson(app, '/api/v1/sessions', { cwd: dir })
    expect(body.code).toBe(0)
    expect(body.data.session_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.id).toBe(body.data.session_id)
    expect(calls[0]!.opts?.newSessionCwd).toBe(dir)
  })

  it('新会话可以直接 prompt：复用 create 时登记的引擎，不再 spawn', async () => {
    const { app, calls, engines, dir } = setup()
    const { body } = await postJson(app, '/api/v1/sessions', { cwd: dir })
    const id = body.data.session_id as string
    const { body: p } = await postJson(app, `/api/v1/sessions/${id}/prompt`, { text: 'hi' })
    expect(p.code).toBe(0)
    expect(calls).toHaveLength(1) // 没有第二次 spawn
    expect(engines.get(id)!.sent).toHaveLength(1)
  })

  it('新会话 jsonl 落盘前 history 回空页，不是 404', async () => {
    const { app, dir } = setup()
    const { body } = await postJson(app, '/api/v1/sessions', { cwd: dir })
    const id = body.data.session_id as string
    const res = await app.request(`/api/v1/sessions/${id}/history`)
    const h = await res.json()
    expect(h.code).toBe(0)
    expect(h.data.messages).toEqual([])
    expect(h.data.has_more).toBe(false)
  })

  it('缺 cwd / 目录不存在 → 信封错误码', async () => {
    const { app } = setup()
    expect((await postJson(app, '/api/v1/sessions', {})).body.code).toBe(40001)
    const bad = await postJson(app, '/api/v1/sessions', { cwd: '/definitely/not/a/dir/xyz' })
    expect(bad.body.code).toBe(40004)
  })

  it('工厂炸了（spawn 失败）→ 50002，不崩', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-web-create-'))
    tmpdirs.push(dir)
    const registry = new SessionRegistry({
      hub: new SessionHub(),
      factory: () => {
        throw new Error('spawn exploded')
      },
    })
    const app = createApp({ projectsRoot: dir, registry })
    const { body } = await postJson(app, '/api/v1/sessions', { cwd: dir })
    expect(body.code).toBe(50002)
    expect(body.msg).toContain('spawn exploded')
  })
})
