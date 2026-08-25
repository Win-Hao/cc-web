/**
 * 契约测试 —— 用**我们自己的引擎**（src/engine）驱动**真实** claude，
 * 把收发的每一帧原样录到 test/fixtures/recorded/。单元测试回放这些帧。
 *
 * D8 之后 probe 不再自己拼帧：它录的 sent 就是 Engine 实际发出的信封，
 * received 就是 Engine 实际吃到的行 —— 契约测试测的是我们的引擎，不是
 * 一份手抄的协议。
 *
 * 不进 `pnpm test`（需要登录态、慢、耗额度）。手动跑：
 *
 *     pnpm test:contract
 *
 * 跑完 `git diff test/fixtures/recorded/`：
 *   diff 为空  → 上游没动协议
 *   有 diff    → 协议变了，看清楚变的是什么再改实现
 *
 * 每个 fixture 配一个 <name>.meta.json，记下录制时的 claude 版本和
 * spawn 参数 —— 没有版本号，将来 diff 出变化时不知道是从哪版变的。
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probeClaudeCapabilities } from '#/engine/capabilities.js'
import { buildEngineArgs, Engine } from '#/engine/index.js'

const RECORDED = fileURLToPath(new URL('../fixtures/recorded', import.meta.url))
const CLAUDE = process.env.CC_WEB_CLAUDE_BIN ?? 'claude'
const TIMEOUT_MS = 90_000

function claudeVersion(): string {
  return execFileSync(CLAUDE, ['--version'], { encoding: 'utf8' }).trim()
}

interface Recorded {
  /** spawn 参数（能力探测之后的实际 flag） */
  args: string[]
  /** 引擎发出的 stdin 帧（JSONL，单元测试对照我们发了什么） */
  sent: string[]
  /** 引擎收到的 stdout 原始行 */
  received: string[]
}

/**
 * 起一个真实引擎：新 session id（不污染日常会话），cwd 用临时目录
 * （避免读用户项目的 CLAUDE.md）。request_id 用固定序号，fixture 才稳定。
 */
async function startEngine(cwd: string): Promise<{ engine: Engine; rec: Recorded }> {
  const caps = await probeClaudeCapabilities(CLAUDE)
  const args = buildEngineArgs(caps, { newSessionId: randomUUID() })
  const rec: Recorded = { args, sent: [], received: [] }
  let n = 0
  const engine = new Engine({
    bin: CLAUDE,
    args,
    cwd,
    newRequestId: () => `probe-${n++}`,
    trace: { sent: (l) => rec.sent.push(l), received: (l) => rec.received.push(l) },
  })
  engine.on('error', () => {}) // 意外退出由断言（录到的帧够不够）判断
  await engine.start()
  return { engine, rec }
}

function withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`probe timed out: ${what}`)), TIMEOUT_MS)),
  ])
}

/** 一轮对话：prompt → 等 turn-end（进程死了也把录到的交出去，由断言判断够不够） */
async function recordTurn(prompt: string, setup?: (cwd: string) => void): Promise<Recorded> {
  const cwd = mkdtempSync(join(tmpdir(), 'cc-web-probe-'))
  setup?.(cwd)
  const { engine, rec } = await startEngine(cwd)
  const done = new Promise<void>((resolve) => {
    engine.once('turn-end', () => resolve())
    engine.once('exit', () => resolve())
  })
  try {
    engine.prompt(prompt)
    await withTimeout(done, `turn "${prompt.slice(0, 30)}"`)
  } finally {
    await engine.stop()
  }
  return rec
}

/** 控制协议：握手 → 列表 → 切模型（每个等到应答再发下一个，Engine 自己保证） */
async function recordControlExchange(): Promise<Recorded> {
  const cwd = mkdtempSync(join(tmpdir(), 'cc-web-probe-'))
  const { engine, rec } = await startEngine(cwd)
  try {
    // error 应答也是协议形状的一部分，照录不抛（单元测试要回放它）
    await withTimeout(engine.control('list_models').catch(() => null), 'list_models')
    await withTimeout(engine.control('set_model', { model: 'claude-sonnet-5' }).catch(() => null), 'set_model')
  } finally {
    await engine.stop()
  }
  return rec
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
        args: rec.args,
        sent: rec.sent,
      },
      null,
      2,
    ) + '\n',
  )
}

const types = (rec: Recorded) => rec.received.map((l) => (JSON.parse(l) as { type?: string }).type)

describe('协议探测：用 Engine 驱动真实 claude 录帧', () => {
  it('录一轮最简对话（system init / assistant / result）', async () => {
    const rec = await recordTurn('Reply with exactly: hi')
    saveFixture('simple-turn', rec)
    expect(rec.received.length).toBeGreaterThan(0)
    expect(types(rec)[0]).toBe('system')
    expect(types(rec)).toContain('assistant')
    expect(types(rec)).toContain('result')
    expect(rec.sent).toHaveLength(1) // 只有那一帧 user
  })

  it('录一轮带工具调用的对话（tool_use 流式入参 / tool_result / 收尾文本）', async () => {
    // Read 在默认权限模式下免审批，所以 -p 模式能跑完整个工具回合。
    // 这份 fixture 是 D7 normalizer 的事实来源：content_block_start(tool_use)、
    // input_json_delta、user 帧里的 tool_result 长什么样都从这里看。
    const rec = await recordTurn(
      'Use the Read tool to read the file hello.txt in the current directory, then reply with exactly its contents and nothing else.',
      (cwd) => writeFileSync(join(cwd, 'hello.txt'), 'cc-web probe says hello\n'),
    )
    saveFixture('tool-turn', rec)
    const frames = rec.received.map((l) => JSON.parse(l) as { type?: string; message?: { content?: unknown } })
    const blockTypes = (f: { message?: { content?: unknown } }) =>
      Array.isArray(f.message?.content)
        ? (f.message!.content as { type?: string }[]).map((b) => b.type)
        : []
    expect(frames.some((f) => f.type === 'assistant' && blockTypes(f).includes('tool_use'))).toBe(true)
    expect(frames.some((f) => f.type === 'user' && blockTypes(f).includes('tool_result'))).toBe(true)
    expect(frames.some((f) => f.type === 'result')).toBe(true)
  })

  it('录控制协议：initialize / list_models / set_model 的请求与响应', async () => {
    const rec = await recordControlExchange()
    saveFixture('control', rec)
    // Engine 发出的三帧：握手（自动）→ 列表 → 切模型；每帧都必须有对应的 control_response
    const sentSubtypes = rec.sent.map((l) => (JSON.parse(l) as { request: { subtype: string } }).request.subtype)
    expect(sentSubtypes).toEqual(['initialize', 'list_models', 'set_model'])
    for (const id of ['probe-0', 'probe-1', 'probe-2']) {
      const found = rec.received.some((l) => {
        const f = JSON.parse(l) as { type?: string; response?: { request_id?: string } }
        return f.type === 'control_response' && f.response?.request_id === id
      })
      expect(found, `missing control_response for ${id}`).toBe(true)
    }
  })
})
