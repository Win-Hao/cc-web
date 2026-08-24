/**
 * M10：交接入口 CLI —— cc-web --resume <id>。
 * 先做简单路（ARCHITECTURE）：服务器是独立 CLI，用户自己开一个终端跑；
 * hook 交接是增强。
 */
import { describe, it, expect } from 'vitest'
import { run, sessionUrl } from '#/server/cli.js'

const BOOT_URL = 'http://127.0.0.1:58630/#token=deadbeef'

function fakeDeps(opened: string[]) {
  return {
    startServer: async () => ({
      port: 58630,
      host: '127.0.0.1',
      token: 'deadbeef',
      url: BOOT_URL,
      close: async () => {},
    }),
    open: (url: string) => opened.push(url),
  }
}

describe('sessionUrl', () => {
  it('session id 加进 query，token 留在 fragment', () => {
    expect(sessionUrl(BOOT_URL, 'abc-123')).toBe(
      'http://127.0.0.1:58630/?session=abc-123#token=deadbeef',
    )
  })

  it('没有 session id 时原样返回', () => {
    expect(sessionUrl(BOOT_URL)).toBe(BOOT_URL)
  })
})

describe('cc-web CLI', () => {
  it('--resume <id> 起服务器并打开对的 URL（session id + #token=）', async () => {
    const opened: string[] = []
    const boot = await run(['--resume', 'abc-123'], fakeDeps(opened))
    expect(opened).toHaveLength(1)
    expect(opened[0]).toContain('session=abc-123')
    expect(opened[0]).toContain('#token=deadbeef')
    expect(boot.url).toBe(opened[0])
    await boot.close()
  })

  it('--no-open 不开浏览器，URL 照样给', async () => {
    const opened: string[] = []
    const boot = await run(['--resume', 'abc-123', '--no-open'], fakeDeps(opened))
    expect(opened).toHaveLength(0)
    expect(boot.url).toContain('session=abc-123')
    expect(boot.url).toContain('#token=deadbeef')
    await boot.close()
  })

  it('不带 --resume 也能起（会话由页面里选）', async () => {
    const opened: string[] = []
    const boot = await run([], fakeDeps(opened))
    expect(opened[0]).toBe(BOOT_URL)
    await boot.close()
  })
})
