/**
 * M5：发提示词 + 中断。
 *
 * stdin 断言用**真 Engine + 假 claude 二进制**（--record 落盘），
 * 状态机断言用 FakeEngine（EventEmitter 桩）—— 各测各的层。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hono } from 'hono'
import { Engine } from '#/engine/engine.js'
import { createApp } from '#/server/app.js'
import { SessionHub } from '#/server/hub.js'
import { SessionRegistry } from '#/server/registry.js'

const FAKE = fileURLToPath(new URL('../fixtures/fake-claude.mjs', import.meta.url))

class FakeEngine extends EventEmitter {
  pid = 4242
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

/** 真 Engine + 假二进制：stdin 会落盘到 recPath */
async function setupReal() {
  const dir = mkdtempSync(join(tmpdir(), 'cc-web-prompt-'))
  tmpdirs.push(dir)
  const recPath = join(dir, 'stdin.ndjson')
  const hub = new SessionHub()
  const registry = new SessionRegistry({
    hub,
    factory: () =>
      new Engine({ bin: process.execPath, args: [FAKE, '--hold', '--record', recPath] }),
  })
  const app = createApp({ projectsRoot: dir, registry })
  return { app, registry, recPath }
}

/** FakeEngine：直接驱动状态机 */
function setupFake() {
  const hub = new SessionHub()
  const engines = new Map<string, FakeEngine>()
  const registry = new SessionRegistry({
    hub,
    factory: (id) => {
      const e = new FakeEngine()
      engines.set(id, e)
      return e
    },
  })
  const dir = mkdtempSync(join(tmpdir(), 'cc-web-prompt-'))
  tmpdirs.push(dir)
  const app = createApp({ projectsRoot: dir, registry })
  return { app, registry, engines }
}

async function postJson(app: Hono, path: string, body: unknown) {
  const res = await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

async function waitFor(assertion: () => void, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      assertion()
      return
    } catch (err) {
      if (Date.now() > deadline) throw err
      await new Promise((r) => setTimeout(r, 20))
    }
  }
}

describe('POST /api/v1/sessions/:id/prompt', () => {
  it('把内容写进了引擎 stdin（user 帧）', async () => {
    const { app, recPath } = await setupReal()
    const { body } = await postJson(app, '/api/v1/sessions/s1/prompt', { text: 'hello world' })
    expect(body.code).toBe(0)
    await waitFor(() => {
      const rec = readFileSync(recPath, 'utf8')
      expect(rec).toContain('"type":"user"')
      expect(rec).toContain('hello world')
    })
  })

  it('缺 text → code !== 0', async () => {
    const { app } = setupFake()
    const { body } = await postJson(app, '/api/v1/sessions/s1/prompt', {})
    expect(body.code).not.toBe(0)
  })

  it('带图片 → user 帧 content 是 image 块 + text 块（M43）', async () => {
    const { app, recPath } = await setupReal()
    const { body } = await postJson(app, '/api/v1/sessions/s1/prompt', {
      text: '这是什么',
      images: [{ media_type: 'image/png', data: 'aGVsbG8=' }],
    })
    expect(body.code).toBe(0)
    await waitFor(() => {
      const frame = JSON.parse(readFileSync(recPath, 'utf8').trim().split('\n')[0]!) as {
        message: { content: unknown[] }
      }
      expect(frame.message.content).toEqual([
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
        { type: 'text', text: '这是什么' },
      ])
    })
  })

  it('只有图片没有文字也能发（M43：截图直接问）', async () => {
    const { app, recPath } = await setupReal()
    const { body } = await postJson(app, '/api/v1/sessions/s1/prompt', {
      images: [{ media_type: 'image/jpeg', data: 'aGVsbG8=' }],
    })
    expect(body.code).toBe(0)
    await waitFor(() => {
      const frame = JSON.parse(readFileSync(recPath, 'utf8').trim().split('\n')[0]!) as {
        message: { content: { type: string }[] }
      }
      expect(frame.message.content).toHaveLength(1)
      expect(frame.message.content[0]!.type).toBe('image')
    })
  })

  it('非法图片被拒：media_type 不在白名单 / data 超限 / 超过 8 张（M43）', async () => {
    const { app } = setupFake()
    const bad1 = await postJson(app, '/api/v1/sessions/s1/prompt', {
      images: [{ media_type: 'image/svg+xml', data: 'aGVsbG8=' }],
    })
    expect(bad1.body.code).not.toBe(0)
    const bad2 = await postJson(app, '/api/v1/sessions/s1/prompt', {
      images: [{ media_type: 'image/png', data: 'A'.repeat(7_100_000) }],
    })
    expect(bad2.body.code).not.toBe(0)
    const bad3 = await postJson(app, '/api/v1/sessions/s1/prompt', {
      images: Array.from({ length: 9 }, () => ({ media_type: 'image/png', data: 'aGVsbG8=' })),
    })
    expect(bad3.body.code).not.toBe(0)
  })

  it('并发两个 prompt 只成功一个（R7 竞态：idle 检查与置位之间不能有 await 窗口）', async () => {
    const { app, engines } = setupFake()
    const results = await Promise.all([
      postJson(app, '/api/v1/sessions/s1/prompt', { text: 'one' }),
      postJson(app, '/api/v1/sessions/s1/prompt', { text: 'two' }),
    ])
    expect(results.filter((r) => r.body.code === 0)).toHaveLength(1)
    expect(engines.get('s1')!.sent).toHaveLength(1)
  })

  it('运行中再发 prompt → 拒绝（R7：串行化，先拒绝）', async () => {
    const { app } = setupFake()
    const first = await postJson(app, '/api/v1/sessions/s1/prompt', { text: 'one' })
    expect(first.body.code).toBe(0)
    const second = await postJson(app, '/api/v1/sessions/s1/prompt', { text: 'two' })
    expect(second.body.code).not.toBe(0)
  })

  it('result 帧到达后状态回 idle，可以再发 prompt', async () => {
    const { app, engines } = setupFake()
    await postJson(app, '/api/v1/sessions/s1/prompt', { text: 'one' })
    engines.get('s1')!.emit('message', { type: 'result', subtype: 'success' })
    const again = await postJson(app, '/api/v1/sessions/s1/prompt', { text: 'two' })
    expect(again.body.code).toBe(0)
    expect(engines.get('s1')!.sent).toHaveLength(2)
  })

  it('引擎退出后状态回 idle，下次 prompt 重新 spawn', async () => {
    const { app, registry, engines } = setupFake()
    await postJson(app, '/api/v1/sessions/s1/prompt', { text: 'one' })
    const first = engines.get('s1')!
    first.emit('exit', 1, null)
    expect(registry.state('s1')).toBe('idle')
    const again = await postJson(app, '/api/v1/sessions/s1/prompt', { text: 'two' })
    expect(again.body.code).toBe(0)
    expect(engines.get('s1')).not.toBe(first) // factory 被再次调用
  })
})

describe('POST /api/v1/sessions/:id/interrupt', () => {
  it('运行中 interrupt → 发出 interrupt 控制帧', async () => {
    const { app, recPath } = await setupReal()
    await postJson(app, '/api/v1/sessions/s1/prompt', { text: 'work' })
    const { body } = await postJson(app, '/api/v1/sessions/s1/interrupt', {})
    expect(body.code).toBe(0)
    await waitFor(() => {
      const rec = readFileSync(recPath, 'utf8')
      expect(rec).toContain('"type":"control_request"')
      expect(rec).toContain('"subtype":"interrupt"')
    })
  })

  it('会话从没启动过 → 不报错，也不发帧', async () => {
    const { app, engines } = setupFake()
    const { body } = await postJson(app, '/api/v1/sessions/never/interrupt', {})
    expect(body.code).toBe(0)
    expect(engines.has('never')).toBe(false) // 不该为它拉起引擎
  })

  it('会话 idle（没在跑）→ 不报错，不发 interrupt 帧', async () => {
    const { app, engines } = setupFake()
    await postJson(app, '/api/v1/sessions/s1/prompt', { text: 'one' })
    engines.get('s1')!.emit('message', { type: 'result', subtype: 'success' })
    const { body } = await postJson(app, '/api/v1/sessions/s1/interrupt', {})
    expect(body.code).toBe(0)
    expect(
      engines.get('s1')!.sent.filter(
        (f) => (f as { type?: string }).type === 'control_request',
      ),
    ).toHaveLength(0)
  })
})

describe('GET /api/v1/sessions 的 state 字段（M54 侧栏运行指示）', () => {
  it('running 会话在列表里被标出，其它是 idle', async () => {
    const { app, recPath } = await setupReal()
    // setupReal 的 projectsRoot 是空 tmpdir —— 铺一个会话文件让列表能看见它
    const dir = recPath.replace(/stdin\.ndjson$/, '')
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    mkdirSync(join(dir, '-tmp-proj'), { recursive: true })
    writeFileSync(
      join(dir, '-tmp-proj', 's1.jsonl'),
      JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, cwd: '/tmp/proj', message: { role: 'user', content: 'hi' } }) + '\n',
    )
    const idle = await getJsonBody(app, '/api/v1/sessions')
    expect(idle.sessions.find((s) => s.session_id === 's1')?.state).toBe('idle')
    await postJson(app, '/api/v1/sessions/s1/prompt', { text: 'go' })
    const busy = await getJsonBody(app, '/api/v1/sessions')
    expect(busy.sessions.find((s) => s.session_id === 's1')?.state).toBe('running')
  })
})

async function getJsonBody(
  app: Hono,
  path: string,
): Promise<{ sessions: { session_id: string; state?: string }[] }> {
  const res = await app.request(path)
  const body = (await res.json()) as { data: { sessions: { session_id: string; state?: string }[] } }
  return body.data
}
