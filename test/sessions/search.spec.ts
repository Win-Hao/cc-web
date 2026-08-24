/**
 * M44：全文搜索 —— 扫 jsonl 的消息文本，按 mtime 倒序、拿够即停。
 * 侧栏原有过滤只搜标题（首条人话），这里补「聊过但记不得在哪个会话」的场景。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { searchSessions } from '#/sessions/search.js'

let root: string

function writeSession(slug: string, id: string, lines: unknown[], mtimeSec: number) {
  const dir = join(root, slug)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${id}.jsonl`)
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  utimesSync(path, mtimeSec, mtimeSec)
}

const user = (text: string, extra: Record<string, unknown> = {}) => ({
  type: 'user', uuid: 'u', cwd: '/w', message: { role: 'user', content: text }, ...extra,
})
const assistant = (text: string) => ({
  type: 'assistant', uuid: 'a', cwd: '/w',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
})

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-web-search-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('searchSessions', () => {
  it('命中消息正文，带 snippet 和会话信息，按 mtime 倒序', async () => {
    writeSession('proj-a', 'aaaaaaaa-0000-0000-0000-000000000001',
      [user('我们聊聊 EPIPE 守卫的实现细节吧')], 1000)
    writeSession('proj-b', 'bbbbbbbb-0000-0000-0000-000000000002',
      [user('今天天气不错'), assistant('EPIPE 是写入已关闭管道的错误')], 2000)
    const hits = await searchSessions(root, 'epipe')
    expect(hits.map((h) => h.session_id)).toEqual([
      'bbbbbbbb-0000-0000-0000-000000000002',
      'aaaaaaaa-0000-0000-0000-000000000001',
    ])
    expect(hits[0]!.project_slug).toBe('proj-b')
    expect(hits[0]!.cwd).toBe('/w')
    expect(hits[0]!.snippet).toContain('EPIPE')
  })

  it('大小写不敏感；同会话多次命中只出一条，带 match_count', async () => {
    writeSession('proj-a', 'aaaaaaaa-0000-0000-0000-000000000001',
      [user('讲讲 Docker'), assistant('docker 是容器'), user('DOCKER compose 呢')], 1000)
    const hits = await searchSessions(root, 'docker')
    expect(hits).toHaveLength(1)
    expect(hits[0]!.match_count).toBe(3)
  })

  it('sidechain 行不参与（subagent 噪音）；base64 图片数据不误命中', async () => {
    writeSession('proj-a', 'aaaaaaaa-0000-0000-0000-000000000001', [
      user('主线消息', {}),
      user('sidechain 里的 needle77', { isSidechain: true }),
      { type: 'user', uuid: 'x', cwd: '/w',
        message: { role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'needle77needle77' } },
        ] } },
    ], 1000)
    expect(await searchSessions(root, 'needle77')).toHaveLength(0)
  })

  it('limit 生效且按 mtime 新→旧扫，拿够即停', async () => {
    for (let i = 0; i < 5; i++) {
      writeSession('proj-a', `aaaaaaaa-0000-0000-0000-00000000000${i}`,
        [user(`共同关键词 magicword，序号 ${i}`)], 1000 + i)
    }
    const hits = await searchSessions(root, 'magicword', { limit: 2 })
    expect(hits).toHaveLength(2)
    expect(hits[0]!.session_id.endsWith('4')).toBe(true)
    expect(hits[1]!.session_id.endsWith('3')).toBe(true)
  })

  it('空查询 / 纯空白 → 空结果，不扫盘', async () => {
    writeSession('proj-a', 'aaaaaaaa-0000-0000-0000-000000000001', [user('内容')], 1000)
    expect(await searchSessions(root, '')).toEqual([])
    expect(await searchSessions(root, '   ')).toEqual([])
  })
})
