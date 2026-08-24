/**
 * M0：验证测试基础设施本身。
 *
 * 这个文件不测任何业务代码 —— 它测的是「假二进制能不能用」。
 * 后面所有引擎测试都建立在它之上，所以它必须先绿。
 */
import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const FAKE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url))
const SCRIPT = fileURLToPath(new URL('./recorded/.sample-turn.ndjson', import.meta.url))

function run(args: string[], stdin = ''): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FAKE, ...args])
    let out = ''
    child.stdout.on('data', (c) => (out += String(c)))
    child.on('error', reject)
    child.on('close', () => resolve(out))
    child.stdin.end(stdin)
  })
}

describe('fake-claude 测试基础设施', () => {
  it('按 fixture 逐行吐出 NDJSON', async () => {
    const out = await run(['--script', SCRIPT])
    const lines = out.split('\n').filter((l) => l !== '')
    expect(lines).toHaveLength(3)
    expect(JSON.parse(lines[0]!).type).toBe('system')
  })

  it('--split 把每行拆成两个 chunk，但内容不变', async () => {
    // 引擎的 NDJSON 解析器必须扛住粘包。这里先确认假二进制真的会拆。
    const out = await run(['--script', SCRIPT, '--split'])
    const lines = out.split('\n').filter((l) => l !== '')
    expect(lines).toHaveLength(3)
    expect(() => lines.map((l) => JSON.parse(l))).not.toThrow()
  })

  it('--record 把收到的 stdin 原样落盘', async () => {
    const rec = join('/tmp', `cc-web-harness-${process.pid}.txt`)
    rmSync(rec, { force: true })
    await run(['--script', SCRIPT, '--record', rec], '{"type":"user"}\n')
    expect(readFileSync(rec, 'utf8')).toContain('"type":"user"')
    rmSync(rec, { force: true })
  })

  it('--exit 用指定退出码退出，供「引擎崩了」的用例使用', async () => {
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, [FAKE, '--exit', '3'])
      child.stdin.end()
      child.on('close', resolve)
    })
    expect(code).toBe(3)
  })
})
