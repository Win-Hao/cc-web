/**
 * M10：SessionEnd hook 脚本（scripts/session-end-hook.mjs）。
 *
 * 流程（ARCHITECTURE「交接怎么做」）：
 *   /cc-web skill 写标记文件 → 用户退出 TUI → SessionEnd hook 读标记，
 *   启动服务器带上 session id，**读完标记就删**，不会下次误触发。
 *
 * 测试用 env 注入标记路径和服务器入口（stub），不起真服务器。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOOK = fileURLToPath(new URL('../../scripts/session-end-hook.mjs', import.meta.url))
const STUB = fileURLToPath(new URL('../fixtures/stub-server-entry.mjs', import.meta.url))

const tmpdirs: string[] = []
afterEach(() => {
  for (const d of tmpdirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function setup(opts: { withMarker: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'cc-web-hook-'))
  tmpdirs.push(dir)
  const marker = join(dir, 'handoff.json')
  const stubOut = join(dir, 'started.json')
  if (opts.withMarker) {
    writeFileSync(marker, JSON.stringify({ session_id: 'abc-123' }))
  }
  return { dir, marker, stubOut }
}

function runHook(marker: string, stubOut: string) {
  return spawnSync(process.execPath, [HOOK], {
    env: {
      ...process.env,
      CC_WEB_MARKER: marker,
      CC_WEB_SERVER_ENTRY: STUB,
      CC_WEB_STUB_OUT: stubOut,
    },
    timeout: 15000,
  })
}

describe('SessionEnd hook', () => {
  it('没有标记文件 → 直接退出，不启动任何东西', () => {
    const { marker, stubOut } = setup({ withMarker: false })
    const res = runHook(marker, stubOut)
    expect(res.status).toBe(0)
    expect(existsSync(stubOut)).toBe(false)
  })

  it('有标记 → 启动服务器（带 --resume <id>），且读完标记就删', () => {
    const { marker, stubOut } = setup({ withMarker: true })
    const res = runHook(marker, stubOut)
    expect(res.status).toBe(0)

    // 读完标记就删 —— 下次 CC 正常退出不会误触发
    expect(existsSync(marker)).toBe(false)

    // 服务器入口被以 --resume abc-123 拉起（stub 把 argv 落盘）
    const deadline = Date.now() + 5000
    while (!existsSync(stubOut)) {
      if (Date.now() > deadline) throw new Error('server entry was not spawned')
      spawnSync('sleep', ['0.05'])
    }
    const started = JSON.parse(readFileSync(stubOut, 'utf8')) as { argv: string[] }
    expect(started.argv).toContain('--resume')
    expect(started.argv).toContain('abc-123')
  })
})
