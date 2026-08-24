/**
 * 契约测试 —— 跑**真实** claude，把收发的每一帧原样录到
 * test/fixtures/recorded/。单元测试回放这些帧。
 *
 * 不进 `pnpm test`（需要登录态、慢、耗额度）。手动跑：
 *
 *     pnpm test:contract
 *
 * 跑完 `git diff test/fixtures/recorded/`：
 *   diff 为空  → 上游没动协议
 *   有 diff    → 协议变了，看清楚变的是什么再改实现
 *
 * 每个 fixture 配一个 <name>.meta.json，记下录制时的 claude 版本 ——
 * 没有版本号，将来 diff 出变化时不知道是从哪版变的。
 */
import { describe, it, expect } from 'vitest'
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const RECORDED = fileURLToPath(new URL('../fixtures/recorded', import.meta.url))
const CLAUDE = process.env.CC_WEB_CLAUDE_BIN ?? 'claude'

function claudeVersion(): string {
  return execFileSync(CLAUDE, ['--version'], { encoding: 'utf8' }).trim()
}

interface Recorded {
  /** 发出的 stdin 帧（JSONL，供单元测试回放时对照我们发了什么） */
  sent: string[]
  /** 收到的 stdout 原始行 */
  received: string[]
}

/**
 * 起一个真实引擎会话：新 session id（不污染日常会话），cwd 用临时目录
 * （避免读用户项目的 CLAUDE.md）。收到 result 帧或超时后结束。
 */
function recordTurn(prompt: string): Promise<Recorded> {
  return new Promise((resolve, reject) => {
    const sessionId = randomUUID()
    const cwd = mkdtempSync(join(tmpdir(), 'cc-web-probe-'))
    const child = spawn(
      CLAUDE,
      [
        '-p',
        '--verbose',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--include-partial-messages',
        '--session-id',
        sessionId,
      ],
      { cwd, stdio: ['pipe', 'pipe', 'pipe'] },
    )

    const sent: string[] = []
    const received: string[] = []
    let stderrBuf = ''
    let buf = ''

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`probe timed out; stderr: ${stderrBuf.slice(-500)}`))
    }, 90_000)

    child.stderr.on('data', (c) => (stderrBuf += String(c)))
    child.stdout.on('data', (c) => {
      buf += String(c)
      for (;;) {
        const i = buf.indexOf('\n')
        if (i === -1) break
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (line.trim() === '') continue
        received.push(line)
        try {
          const frame = JSON.parse(line) as { type?: string }
          if (frame.type === 'result') {
            clearTimeout(timer)
            child.kill('SIGTERM')
            resolve({ sent, received })
            return
          }
        } catch {
          // 原样录下来，解析留给单元测试
        }
      }
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ sent, received }) // 进程死了也把录到的交出去，由断言判断够不够
      void code
    })

    const userFrame = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: prompt }],
      },
    })
    sent.push(userFrame)
    child.stdin.write(userFrame + '\n')
  })
}

function saveFixture(name: string, rec: Recorded): void {
  mkdirSync(RECORDED, { recursive: true })
  writeFileSync(`${RECORDED}/${name}.ndjson`, rec.received.join('\n') + '\n')
  writeFileSync(
    `${RECORDED}/${name}.meta.json`,
    JSON.stringify(
      {
        claude_version: claudeVersion(),
        recorded_at: new Date().toISOString(),
        sent: rec.sent,
      },
      null,
      2,
    ) + '\n',
  )
}

/** 依次发控制请求，每个等到对应的 control_response 再发下一个。 */
function recordControlExchange(): Promise<Recorded> {
  return new Promise((resolve, reject) => {
    const sessionId = randomUUID()
    const cwd = mkdtempSync(join(tmpdir(), 'cc-web-probe-'))
    const child = spawn(
      CLAUDE,
      [
        '-p',
        '--verbose',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--session-id',
        sessionId,
      ],
      { cwd, stdio: ['pipe', 'pipe', 'pipe'] },
    )

    const sent: string[] = []
    const received: string[] = []
    let buf = ''

    // 要录的控制请求：握手 → 列表 → 切模型
    const queue = [
      { subtype: 'initialize' },
      { subtype: 'list_models' },
      { subtype: 'set_model', model: 'claude-sonnet-5' },
    ] as const
    let cursor = 0

    const sendNext = (): boolean => {
      const req = queue[cursor]
      if (req === undefined) return false
      const frame = JSON.stringify({
        type: 'control_request',
        request_id: `probe-${cursor}`,
        request: req,
      })
      sent.push(frame)
      child.stdin.write(frame + '\n')
      return true
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      // 超时也把录到一半的交出去 —— 失败现场本身就是信息
      resolve({ sent, received })
    }, 90_000)

    child.stderr.on('data', () => {})
    child.stdout.on('data', (c) => {
      buf += String(c)
      for (;;) {
        const i = buf.indexOf('\n')
        if (i === -1) break
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (line.trim() === '') continue
        received.push(line)
        try {
          const frame = JSON.parse(line) as {
            type?: string
            response?: { request_id?: string }
          }
          if (
            frame.type === 'control_response' &&
            frame.response?.request_id === `probe-${cursor}`
          ) {
            cursor++
            if (!sendNext()) {
              clearTimeout(timer)
              child.kill('SIGTERM')
              resolve({ sent, received })
            }
          }
        } catch {
          // 原样录，解析留给单元测试
        }
      }
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', () => {
      clearTimeout(timer)
      resolve({ sent, received })
    })

    sendNext()
  })
}

describe('协议探测：录制真实帧', () => {
  it('录一轮最简对话（system init / assistant / result）', async () => {
    const rec = await recordTurn('Reply with exactly: hi')
    saveFixture('simple-turn', rec)
    const types = rec.received.map((l) => (JSON.parse(l) as { type?: string }).type)
    expect(rec.received.length).toBeGreaterThan(0)
    expect(types[0]).toBe('system')
    expect(types).toContain('assistant')
    expect(types).toContain('result')
  })

  it('录控制协议：initialize / list_models / set_model 的请求与响应', async () => {
    const rec = await recordControlExchange()
    saveFixture('control', rec)
    // 三个请求都必须有对应的 control_response；response 是 error 也录下来
    // （error 也是协议形状的一部分，单元测试要回放它）
    for (const id of ['probe-0', 'probe-1', 'probe-2']) {
      const found = rec.received.some((l) => {
        const f = JSON.parse(l) as {
          type?: string
          response?: { request_id?: string }
        }
        return f.type === 'control_response' && f.response?.request_id === id
      })
      expect(found, `missing control_response for ${id}`).toBe(true)
    }
  })
})
