/**
 * M22：目录浏览接口 —— 草稿态「选择文件夹…」的数据源。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hono } from 'hono'
import { createApp } from '#/server/app.js'

let root: string
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-web-fs-'))
  mkdirSync(join(root, 'proj-b'))
  mkdirSync(join(root, 'proj-a'))
  mkdirSync(join(root, '.hidden'))
  writeFileSync(join(root, 'a-file.txt'), 'x') // 文件不该出现在目录列表里
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

async function getJson(app: Hono, path: string) {
  const res = await app.request(path)
  return (await res.json()) as { code: number; data: { path?: string; dirs?: string[]; home?: string } }
}

describe('GET /api/v1/fs/dirs', () => {
  it('列出子目录（排序、不含隐藏目录和文件）', async () => {
    const app = createApp({ projectsRoot: root })
    const { code, data } = await getJson(app, `/api/v1/fs/dirs?path=${encodeURIComponent(root)}`)
    expect(code).toBe(0)
    expect(data.path).toBe(root)
    expect(data.dirs).toEqual(['proj-a', 'proj-b'])
  })

  it('读不了的路径 / 相对路径 → 信封错误码', async () => {
    const app = createApp({ projectsRoot: root })
    expect((await getJson(app, '/api/v1/fs/dirs?path=/definitely/not/there')).code).toBe(40005)
    expect((await getJson(app, '/api/v1/fs/dirs?path=relative/x')).code).toBe(40006)
  })

  it('meta 带 home（前端缩写 ~/ 用）', async () => {
    const app = createApp({ projectsRoot: root })
    const { data } = await getJson(app, '/api/v1/meta')
    expect(data.home).toMatch(/^\//)
  })
})
