/**
 * M11 手工验证辅助：用假 claude 引擎起服务器（fixture 会话），
 * 冒烟「页面能开、API 通、鉴权在」。真机验证：
 *   pnpm dev -- --resume <真实会话id>
 * 然后浏览器打开打印的 URL，过一遍：看历史 / 发消息 / 流式输出 /
 * 弹审批 / 切模型。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServer } from '../src/server/bootstrap.js'
import { Engine } from '../src/engine/index.js'

const fixtures = fileURLToPath(new URL('../test/fixtures/sessions', import.meta.url))
const fakeClaude = fileURLToPath(new URL('../test/fixtures/fake-claude.mjs', import.meta.url))

const boot = await startServer({
  projectsRoot: fixtures,
  tokenPath: join(mkdtempSync(join(tmpdir(), 'cc-web-smoke-')), 'server.token'),
  factory: () => new Engine({ bin: process.execPath, args: [fakeClaude, '--hold'] }),
  port: 0,
})

let failed = false
const check = (name: string, cond: boolean) => {
  console.log(`${cond ? 'ok' : 'FAIL'}  ${name}`)
  if (!cond) failed = true
}

const page = await fetch(`http://127.0.0.1:${boot.port}/`)
check('GET / → 200', page.status === 200)
check('页面包含占位 UI', (await page.text()).includes('cc-web'))

const unauthorized = await fetch(`http://127.0.0.1:${boot.port}/api/v1/sessions`)
check('无 token → 401', unauthorized.status === 401)

const sessions = await fetch(`http://127.0.0.1:${boot.port}/api/v1/sessions`, {
  headers: { authorization: `Bearer ${boot.token}` },
})
const env = (await sessions.json()) as { code: number; data: { sessions: unknown[] } }
check('带 token → 3 个 fixture 会话', env.data.sessions.length === 3)

console.log(`\n手动开这个 URL 过一遍 UI：${boot.url}`)
await boot.close()
process.exit(failed ? 1 : 0)
