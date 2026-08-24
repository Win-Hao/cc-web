/**
 * M55：右键菜单背后的三个服务端能力 —— 分叉 / 重命名 / 导出。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine } from '#/engine/engine.js'
import { createApp } from '#/server/app.js'
import { SessionHub } from '#/server/hub.js'
import { SessionRegistry } from '#/server/registry.js'

const FAKE = fileURLToPath(new URL('../fixtures/fake-claude.mjs', import.meta.url))
const FIXTURES = fileURLToPath(new URL('../fixtures/sessions', import.meta.url))

const tmpdirs: string[] = []
afterEach(() => {
  for (const d of tmpdirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'cc-web-menu-'))
  tmpdirs.push(d)
  return d
}

async function postJson(app: ReturnType<typeof createApp>, path: string, body: unknown) {
  const res = await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return (await res.json()) as { code: number; data: Record<string, unknown> | null }
}

describe('POST /sessions/:id/fork（M55）', () => {
  it('从首帧读回 CC 发的新 session id，引擎登记到新 id 下', async () => {
    const dir = tmp()
    // fake 引擎首帧就带新 session_id（真机实测 --fork-session 行为一致）
    const script = join(dir, 'fork.ndjson')
    writeFileSync(
      script,
      JSON.stringify({ type: 'system', subtype: 'hook_started', session_id: 'ffffffff-0000-0000-0000-000000000009' }) + '\n',
    )
    const hub = new SessionHub()
    const registry = new SessionRegistry({
      hub,
      factory: (_id, opts) => {
        expect(opts?.forkFrom).toBe('old-1')
        return new Engine({ bin: process.execPath, args: [FAKE, '--script', script, '--hold'] })
      },
    })
    const app = createApp({ projectsRoot: dir, registry })
    const { code, data } = await postJson(app, '/api/v1/sessions/old-1/fork', {})
    expect(code).toBe(0)
    expect(data!.session_id).toBe('ffffffff-0000-0000-0000-000000000009')
    expect(registry.get('ffffffff-0000-0000-0000-000000000009')).toBeDefined()
    await registry.stopAll()
  })

  it('引擎一直不报 id → 超时报错，不挂死', async () => {
    const dir = tmp()
    const hub = new SessionHub()
    const registry = new SessionRegistry({
      hub,
      factory: () => new Engine({ bin: process.execPath, args: [FAKE, '--hold'] }),
    })
    const app = createApp({ projectsRoot: dir, registry })
    // 直接调 registry.fork 传短超时（HTTP 层默认 15s，测试等不起）
    await expect(registry.fork('old-1', 300)).rejects.toThrow(/timed out/)
    await registry.stopAll()
  })
})

describe('会话重命名（M55）', () => {
  it('改名落 sidecar，列表带 name；空名清除', async () => {
    const dir = tmp()
    const namesPath = join(dir, 'names.json')
    const app = createApp({ projectsRoot: FIXTURES, namesPath })
    const set = await postJson(app, '/api/v1/sessions/aaaaaaaa-0000-0000-0000-000000000001/name', { name: '  我的实验  ' })
    expect(set.code).toBe(0)
    expect(set.data!.name).toBe('我的实验')

    const list = (await (await app.request('/api/v1/sessions')).json()) as {
      data: { sessions: { session_id: string; name: string | null }[] }
    }
    const row = list.data.sessions.find((s) => s.session_id === 'aaaaaaaa-0000-0000-0000-000000000001')
    expect(row?.name).toBe('我的实验')

    const clear = await postJson(app, '/api/v1/sessions/aaaaaaaa-0000-0000-0000-000000000001/name', { name: '' })
    expect(clear.data!.name).toBeNull()
  })
})

describe('GET /sessions/:id/archive（M57/M58：会话诊断包，对齐参考实现）', () => {
  it('打包转写 + file-history + image-cache + todos + manifest.json；缺哪个跳哪个', async () => {
    const root = tmp()
    const claudeHome = tmp()
    const slug = join(root, '-tmp-arch')
    mkdirSync(join(slug, 'e1', 'subagents'), { recursive: true })
    writeFileSync(
      join(slug, 'e1.jsonl'),
      JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, timestamp: '2026-08-25T00:00:00.000Z', cwd: '/w', message: { role: 'user', content: 'hi' } }) + '\n' +
      JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-08-25T00:01:00.000Z', cwd: '/w', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }) + '\n',
    )
    writeFileSync(join(slug, 'e1', 'subagents', 'agent-x.jsonl'), '{}\n')
    mkdirSync(join(claudeHome, 'file-history', 'e1'), { recursive: true })
    writeFileSync(join(claudeHome, 'file-history', 'e1', 'abc@v1'), 'snapshot')
    mkdirSync(join(claudeHome, 'image-cache', 'e1'), { recursive: true })
    writeFileSync(join(claudeHome, 'image-cache', 'e1', '1.png'), 'png')
    mkdirSync(join(claudeHome, 'todos'), { recursive: true })
    writeFileSync(join(claudeHome, 'todos', 'e1-agent-e1.json'), '[]')
    writeFileSync(join(claudeHome, 'todos', 'other.json'), '[]')
    const app = createApp({ projectsRoot: root, namesPath: join(root, 'n.json'), claudeHome })

    const res = await app.request('/api/v1/sessions/e1/archive')
    expect(res.headers.get('content-type')).toContain('gzip')
    const buf = Buffer.from(await res.arrayBuffer())
    const out = join(root, 'out.tar.gz')
    writeFileSync(out, buf)
    const { execFileSync } = await import('node:child_process')
    const listing = execFileSync('tar', ['-tzf', out]).toString()
    expect(listing).toContain('transcript/e1.jsonl')
    expect(listing).toContain('transcript/e1/subagents/agent-x.jsonl')
    expect(listing).toContain('file-history/abc@v1')
    expect(listing).toContain('image-cache/1.png')
    expect(listing).toContain('todos/e1-agent-e1.json')
    expect(listing).not.toContain('other.json')
    expect(listing).toContain('manifest.json')

    // manifest 内容抽出来核一眼
    const extractDir = join(root, 'x')
    mkdirSync(extractDir)
    execFileSync('tar', ['-xzf', out, '-C', extractDir, 'manifest.json'])
    const manifest = JSON.parse(String(execFileSync('cat', [join(extractDir, 'manifest.json')]))) as Record<string, unknown>
    expect(manifest.session_id).toBe('e1')
    expect(manifest.cwd).toBe('/w')
    expect(manifest.first_activity).toBe('2026-08-25T00:00:00.000Z')
    expect(manifest.last_activity).toBe('2026-08-25T00:01:00.000Z')
    expect(Array.isArray(manifest.sections)).toBe(true)

    const missing = await app.request('/api/v1/sessions/zzzz/archive')
    expect(((await missing.json()) as { code: number }).code).toBe(40401)
  })

  it('只有主 jsonl 也能打包（可选目录全缺）', async () => {
    const root = tmp()
    const slug = join(root, '-tmp-min')
    mkdirSync(slug, { recursive: true })
    writeFileSync(join(slug, 'e2.jsonl'), JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'hi' } }) + '\n')
    const app = createApp({ projectsRoot: root, namesPath: join(root, 'n.json'), claudeHome: tmp() })
    const res = await app.request('/api/v1/sessions/e2/archive')
    const out = join(root, 'out2.tar.gz')
    writeFileSync(out, Buffer.from(await res.arrayBuffer()))
    const { execFileSync } = await import('node:child_process')
    const listing = execFileSync('tar', ['-tzf', out]).toString()
    expect(listing).toContain('transcript/e2.jsonl')
    expect(listing).toContain('manifest.json')
  })
})

describe('GET /sessions/:id/export（M55）', () => {
  it('导出 Markdown：分角色、含工具注记；不存在的会话报 40401', async () => {
    const app = createApp({ projectsRoot: FIXTURES, namesPath: join(tmp(), 'n.json') })
    const res = await app.request('/api/v1/sessions/aaaaaaaa-0000-0000-0000-000000000001/export')
    expect(res.headers.get('content-type')).toContain('text/markdown')
    const md = await res.text()
    expect(md).toContain('## 用户')
    expect(md).toContain('## 助手')

    const missing = await app.request('/api/v1/sessions/zzzz/export')
    const body = (await missing.json()) as { code: number }
    expect(body.code).toBe(40401)
  })
})
