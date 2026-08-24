/**
 * React 前端的静态托管：有构建产物（webRoot）用产物，没有回退占位 UI；
 * /assets 只认白名单文件名，路径穿越直接 404。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '#/server/app.js'

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-web-static-'))
  mkdirSync(join(dir, 'web', 'assets'), { recursive: true })
  writeFileSync(join(dir, 'web', 'index.html'), '<html>built ui</html>')
  writeFileSync(join(dir, 'web', 'assets', 'index-abc123.js'), 'console.log(1)')
  writeFileSync(join(dir, 'secret.txt'), 'nope')
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('静态托管', () => {
  it('webRoot 有产物：GET / 回构建出来的 index.html', async () => {
    const app = createApp({ projectsRoot: dir, webRoot: join(dir, 'web') })
    const res = await app.request('/')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('built ui')
  })

  it('webRoot 没产物：回退占位 UI（开箱能用）', async () => {
    const app = createApp({ projectsRoot: dir, webRoot: join(dir, 'does-not-exist') })
    const res = await app.request('/')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('cc-web')
  })

  it('/assets/<file> 带正确 content-type', async () => {
    const app = createApp({ projectsRoot: dir, webRoot: join(dir, 'web') })
    const res = await app.request('/assets/index-abc123.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/javascript')
    expect(await res.text()).toBe('console.log(1)')
  })

  it('路径穿越 / 不存在的文件 → 404', async () => {
    const app = createApp({ projectsRoot: dir, webRoot: join(dir, 'web') })
    expect((await app.request('/assets/..%2F..%2Fsecret.txt')).status).toBe(404)
    expect((await app.request('/assets/nope.js')).status).toBe(404)
  })
})
