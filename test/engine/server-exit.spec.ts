/**
 * M1 / R1：服务器进程退出时，引擎子进程一起死。
 * SIGINT / SIGTERM / 正常退出各一条。
 *
 * 通过真的 spawn 一个「假服务器」进程来测 —— 信号和 exit 钩子是
 * 进程级行为，在同一个 vitest 进程里测不出来。
 */
import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const FAKE = fileURLToPath(new URL('../fixtures/fake-claude.mjs', import.meta.url))
const FAKE_SERVER = fileURLToPath(new URL('../fixtures/fake-server.mts', import.meta.url))

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function startServer(extra: string[] = []): Promise<{
  child: ChildProcess
  enginePid: number
}> {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', FAKE_SERVER, FAKE, ...extra],
    {
      stdio: ['ignore', 'pipe', 'inherit'],
      env: {
        ...process.env,
        // 用户 shell 里可能挂着指向别的项目的 TSX_TSCONFIG_PATH，
        // 钉到本项目的 tsconfig.json，否则 tsx 起不来
        TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../tsconfig.json', import.meta.url)),
      },
    },
  )
  let buf = ''
  const enginePid = await new Promise<number>((resolve, reject) => {
    child.on('error', reject)
    child.stdout!.on('data', (c) => {
      buf += String(c)
      const m = buf.match(/ENGINE_PID=(\d+)/)
      if (m) resolve(Number(m[1]))
    })
    child.on('close', (code) =>
      reject(new Error(`fake server exited too early: code=${code} out=${buf}`)),
    )
  })
  return { child, enginePid }
}

function waitExit(child: ChildProcess): Promise<void> {
  return new Promise((r) => child.on('close', () => r()))
}

async function waitDead(pid: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!alive(pid)) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`pid ${pid} still alive after ${timeoutMs}ms`)
}

describe('服务器退出时子进程一起死', () => {
  it('SIGINT', { timeout: 20000 }, async () => {
    const { child, enginePid } = await startServer()
    expect(alive(enginePid)).toBe(true)
    child.kill('SIGINT')
    await waitExit(child)
    await waitDead(enginePid)
  })

  it('SIGTERM', { timeout: 20000 }, async () => {
    const { child, enginePid } = await startServer()
    expect(alive(enginePid)).toBe(true)
    child.kill('SIGTERM')
    await waitExit(child)
    await waitDead(enginePid)
  })

  it('正常退出（exit 0）', { timeout: 20000 }, async () => {
    const { child, enginePid } = await startServer(['--exit-normally'])
    expect(alive(enginePid)).toBe(true)
    await waitExit(child)
    await waitDead(enginePid)
  })
})
