/**
 * M2：列出某目录下的所有会话，按 mtime 倒序。
 *
 * fixture 目录的 mtime 在 git 操作后不稳定，所以测试把 fixture
 * 复制到临时目录再用 utimesSync 钉住 mtime。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { fileURLToPath } from 'node:url'
import { cpSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listSessions } from '#/sessions/list.js'

const FIXTURES = fileURLToPath(new URL('../fixtures/sessions', import.meta.url))

let root: string
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-web-sessions-'))
  cpSync(FIXTURES, root, { recursive: true })
  // 钉住 mtime：A 最新，C 次之，B 最旧
  utimesSync(`${root}/-Users-x-proj-a/aaaaaaaa-0000-0000-0000-000000000001.jsonl`, 0, new Date('2026-08-23T00:00:00Z'))
  utimesSync(`${root}/-Users-x-proj-c/cccccccc-0000-0000-0000-000000000003.jsonl`, 0, new Date('2026-08-22T00:00:00Z'))
  utimesSync(`${root}/-Users-x-proj-b/bbbbbbbb-0000-0000-0000-000000000002.jsonl`, 0, new Date('2026-08-21T00:00:00Z'))
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('listSessions', () => {
  it('列出所有会话，按 mtime 倒序', async () => {
    const sessions = await listSessions(root)
    expect(sessions.map((s) => s.session_id)).toEqual([
      'aaaaaaaa-0000-0000-0000-000000000001',
      'cccccccc-0000-0000-0000-000000000003',
      'bbbbbbbb-0000-0000-0000-000000000002',
    ])
  })

  it('带来 project slug 和从 jsonl 行里读出的 cwd', async () => {
    const sessions = await listSessions(root)
    const a = sessions.find((s) => s.session_id.startsWith('aaaaaaaa'))!
    expect(a.project_slug).toBe('-Users-x-proj-a')
    expect(a.cwd).toBe('/Users/x/proj-a')
    // 空文件没有 cwd 可读 → null，不猜（slug 不可逆，见 slug.ts 注释）
    const b = sessions.find((s) => s.session_id.startsWith('bbbbbbbb'))!
    expect(b.cwd).toBeNull()
  })

  it('首条用户消息摘要：字符串和 block 两种 content 都认', async () => {
    const sessions = await listSessions(root)
    const a = sessions.find((s) => s.session_id.startsWith('aaaaaaaa'))!
    expect(a.first_message).toBe('hello from session A')
    const b = sessions.find((s) => s.session_id.startsWith('bbbbbbbb'))!
    expect(b.first_message).toBeNull()
  })

  it('忽略非 jsonl 文件', async () => {
    const sessions = await listSessions(root)
    expect(sessions).toHaveLength(3)
  })
})

describe('会话标题（first_message）的元信息过滤', () => {
  const userRow = (uuid: string, parent: string | null, text: string) =>
    JSON.stringify({
      type: 'user',
      uuid,
      parentUuid: parent,
      cwd: '/Users/x/proj-d',
      message: { role: 'user', content: text },
    })

  async function withSession(lines: string[]) {
    const dir = mkdtempSync(join(tmpdir(), 'cc-web-title-'))
    try {
      mkdirSync(join(dir, '-Users-x-proj-d'))
      writeFileSync(
        join(dir, '-Users-x-proj-d', 'dddddddd-0000-0000-0000-000000000004.jsonl'),
        lines.join('\n') + '\n',
      )
      return (await listSessions(dir))[0]!
    } finally {
      // listSessions 已经读完，目录可删
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it("以 '<' 开头的元信息（caveat / ide_opened_file …）不当标题，取第一条真实文本", async () => {
    const s = await withSession([
      userRow('u1', null, '<local-command-caveat>Caveat: the messages below…</local-command-caveat>'),
      userRow('u2', 'u1', '真实的第一句话'),
    ])
    expect(s.first_message).toBe('真实的第一句话')
  })

  it('标签块后面跟着人话：剥掉块取剩余文本', async () => {
    const s = await withSession([
      userRow('u1', null, '<ide_opened_file>The user opened a.ts</ide_opened_file>\n继续做重构'),
    ])
    expect(s.first_message).toBe('继续做重构')
  })

  it('全是元信息时退回第一条的标签内文本（去掉尖括号，内容保留）', async () => {
    const s = await withSession([userRow('u1', null, '<bash-input>git init</bash-input>')])
    expect(s.first_message).toBe('git init')
  })
})
