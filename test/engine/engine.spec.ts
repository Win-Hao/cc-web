/**
 * M1：引擎生命周期 —— 构造注入 bin/args、start/stop、崩溃不静默。
 *
 * 全部用假二进制（test/fixtures/fake-claude.mjs），不碰真实 claude。
 */
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Engine } from '#/engine/engine.js'

const FAKE = fileURLToPath(new URL('../fixtures/fake-claude.mjs', import.meta.url))
const SCRIPT = fileURLToPath(new URL('../fixtures/recorded/.sample-turn.ndjson', import.meta.url))

function makeEngine(extraArgs: string[] = []): Engine {
  // 注入 bin/args —— 测试全程不经过 PATH 里的真实 claude，
  // 事件来自假二进制这件事本身就是「注入生效」的证明（TDD M1 第一条）。
  return new Engine({
    bin: process.execPath,
    args: [FAKE, '--script', SCRIPT, ...extraArgs],
  })
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('Engine 生命周期', () => {
  it('start() 之后进程在跑，stdout 的 NDJSON 帧变成 message 事件', async () => {
    const engine = makeEngine()
    const messages: unknown[] = []
    engine.on('message', (m) => messages.push(m))
    await engine.start()
    expect(engine.pid).toBeTypeOf('number')
    expect(alive(engine.pid!)).toBe(true)
    await new Promise<void>((r) => engine.on('exit', () => r()))
    expect(messages).toHaveLength(3)
    expect((messages[0] as { type: string }).type).toBe('system')
  })

  it('stop() 之后进程没了', async () => {
    const engine = makeEngine(['--hold'])
    await engine.start()
    const pid = engine.pid!
    expect(alive(pid)).toBe(true)
    await engine.stop()
    expect(alive(pid)).toBe(false)
  })

  it('进程自己崩了（非 0 退出）会 emit error，不会静默', async () => {
    const engine = makeEngine(['--exit', '3'])
    const errPromise = new Promise<Error>((r) => engine.on('error', r))
    await engine.start()
    const err = await errPromise
    expect(err.message).toContain('3')
  })

  it('意外死亡的错误信息带 stderr 尾巴（死因诊断，M40）', async () => {
    const engine = makeEngine(['--exit', '2', '--stderr', 'Invalid API key · Please run /login'])
    const errPromise = new Promise<Error>((r) => engine.on('error', r))
    await engine.start()
    const err = await errPromise
    expect(err.message).toContain('Invalid API key')
    expect(engine.stderrTail).toContain('/login')
  })

  it('正常退出（exit 0）不 emit error，且没人听 error 也不崩服务器', async () => {
    const engine = makeEngine()
    const onError = vi.fn()
    engine.on('error', onError)
    await engine.start()
    await new Promise<void>((r) => engine.on('exit', () => r()))
    expect(onError).not.toHaveBeenCalled()
  })

  it('中文帧的字节被拆在两个 chunk 里也不乱码（UTF-8 跨 chunk 解码）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-web-utf8-'))
    try {
      const script = join(dir, 'utf8.ndjson')
      const frame = { type: 'assistant', text: '中文流式输出没乱码' }
      writeFileSync(script, JSON.stringify(frame) + '\n')
      const engine = new Engine({
        bin: process.execPath,
        args: [FAKE, '--script', script, '--split-bytes'],
      })
      const messages: unknown[] = []
      engine.on('message', (m) => messages.push(m))
      await engine.start()
      await new Promise<void>((r) => engine.on('exit', () => r()))
      expect(messages).toEqual([frame])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('引擎垂死时的 stdin 写入不崩服务器进程（EPIPE 守卫，M38）', async () => {
    const engine = makeEngine(['--exit', '0'])
    await engine.start()
    const exited = new Promise<void>((r) => engine.on('exit', () => r()))
    // 进程正在退出的窗口里连续写：任何一次都不许变成未处理的 stream error
    for (let i = 0; i < 30; i++) {
      try {
        engine.send({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'x' }] } })
      } catch {
        break // 「engine is not running」是预期的失败方式
      }
      await new Promise((r) => setTimeout(r, 5))
    }
    await exited
    // 走到这里 = 没有未处理异常崩掉测试进程
  })

  it('子进程已被信号杀死后再 stop() 立即返回，不挂起', async () => {
    const engine = makeEngine(['--hold'])
    await engine.start()
    const exited = new Promise<void>((r) => engine.on('exit', () => r()))
    process.kill(-engine.pid!, 'SIGKILL')
    await exited
    await engine.stop(200) // 修复前：等不到已经发过的 close 事件，永久挂起
  })
})
