/**
 * M16：close() 的完整语义 —— 关服务器要把引擎一起停掉，
 * 不能只关 HTTP 留一堆孤儿 claude 进程。
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from '#/server/bootstrap.js'
import { fakeEngines } from '../fixtures/fake-engine.js'

describe('BootResult.close', () => {
  it('close() 停掉所有活着的引擎', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-web-close-'))
    const { factory, all: engines } = fakeEngines()
    const boot = await startServer({
      projectsRoot: dir,
      tokenPath: join(dir, 'server.token'),
      factory,
      port: 0,
    })
    const res = await fetch(`http://127.0.0.1:${boot.port}/api/v1/sessions/s1/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${boot.token}` },
      body: JSON.stringify({ text: 'hi' }),
    })
    expect(((await res.json()) as { code: number }).code).toBe(0)
    expect(engines).toHaveLength(1)
    expect(engines[0]!.stopped).toBe(false)

    await boot.close()
    expect(engines[0]!.stopped).toBe(true)
  })
})
