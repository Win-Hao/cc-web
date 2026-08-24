#!/usr/bin/env node
/**
 * 假的 `claude` 二进制 —— 测试基础设施，不是实现。
 *
 * 单元测试永远不跑真实 claude（慢、要登录态、会耗额度）。这个脚本冒充它：
 * 按 NDJSON 脚本吐帧到 stdout，同时把收到的 stdin 原样落盘供断言。
 *
 * 用法：
 *   node fake-claude.mjs --script <ndjson> [--record <out>] [--split] [--delay <ms>] [--exit <code>]
 *
 *   --script  要吐出去的 NDJSON 文件（每行一帧）
 *   --record  把收到的 stdin 原样写到这里，测试用它断言我们发了什么
 *   --split   把每行拆成两个 chunk 发 —— 专门用来触发粘包，
 *             引擎的 NDJSON 解析器必须扛得住（见 docs/TDD.md M1）
 *   --split-bytes  把每行按**字节**拆开，切在多字节字符中间 ——
 *             专门钉 UTF-8 跨 chunk 解码（引擎必须 setEncoding）
 *   --delay   每帧之间的间隔毫秒，模拟流式
 *   --exit    吐完之后用这个码退出，默认 0；非 0 用来测「引擎崩了」
 *   --stderr <text>  启动时往 stderr 写这段文字 —— 测死亡诊断（M40）
 *   --hold    吐完之后不退出，挂着直到被杀 —— 测 stop()/退出钩子用
 *   --echo-result  每收到一行 stdin 就回一帧 {"type":"result","subtype":"success"}
 *             —— 模拟「每轮对话以 result 收尾」，测状态机/刷新逻辑用
 *   --auto-control  对收到的 control_request 回内置的 success 应答
 *             （initialize/list_models/get_settings/get_context_usage…），
 *             UI 全链路可以完全离线验证
 *   --spawn-sleeper  启动时再 spawn 一个不死孙进程（同进程组），并先吐一帧
 *             {"type":"fake-claude.sleeper","pid":N} —— 测按进程组杀（R1）用
 */

import { readFileSync, createWriteStream, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const has = (name) => process.argv.includes(`--${name}`)

const scriptPath = arg('script')
const recordPath = arg('record')
const split = has('split')
const splitBytes = has('split-bytes')
const delay = Number(arg('delay', '0'))
const exitCode = Number(arg('exit', '0'))
const stderrText = arg('stderr')
if (stderrText !== undefined) process.stderr.write(stderrText + '\n')
const hold = has('hold')
const spawnSleeper = has('spawn-sleeper')
const echoResult = has('echo-result')
const autoControl = has('auto-control')

// 收 stdin 并落盘。注意即使不 record 也要 resume()，
// 否则 stdin 缓冲区满了会把父进程的写阻塞住。
if (recordPath !== undefined) {
  mkdirSync(dirname(recordPath), { recursive: true })
  const out = createWriteStream(recordPath, { flags: 'a' })
  process.stdin.pipe(out)
} else {
  process.stdin.resume()
  process.stdin.on('data', () => {})
}

// 内置控制应答表（--auto-control）
const CANNED = {
  initialize: {},
  list_models: {
    models: [
      { value: 'default', displayName: 'Default (recommended)', description: 'Opus 5 with 1M context', resolvedModel: 'claude-opus-5[1m]', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { value: 'haiku', displayName: 'Haiku', description: 'Fastest', resolvedModel: 'claude-haiku-4-5', supportsEffort: false, supportedEffortLevels: [] },
    ],
  },
  get_settings: { applied: { effort: 'max', model: 'claude-opus-5[1m]' } },
  get_context_usage: { totalTokens: 201000, maxTokens: 1000000, percentage: 20.1, categories: [] },
  get_usage: {
    session: { total_cost_usd: 0.12, model_usage: {} },
    rate_limits_available: true,
    subscription_type: 'pro',
    rate_limits: {
      five_hour: { utilization: 21, resets_at: '2026-08-24T20:00:00+08:00' },
      seven_day: { utilization: 6, resets_at: '2026-08-31T00:00:00+08:00' },
    },
  },
}

if (echoResult || autoControl) {
  let inBuf = ''
  process.stdin.on('data', (c) => {
    if (!autoControl) {
      if (echoResult) process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success' }) + '\n')
      return
    }
    inBuf += String(c)
    let i
    while ((i = inBuf.indexOf('\n')) !== -1) {
      const line = inBuf.slice(0, i)
      inBuf = inBuf.slice(i + 1)
      if (line.trim() === '') continue
      let frame
      try { frame = JSON.parse(line) } catch { continue }
      if (frame.type === 'control_request') {
        const canned = CANNED[frame.request?.subtype] ?? {}
        process.stdout.write(JSON.stringify({
          type: 'control_response',
          response: { subtype: 'success', request_id: frame.request_id, response: canned },
        }) + '\n')
      } else if (frame.type === 'user' && echoResult) {
        process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success' }) + '\n')
      }
    }
  })
}

const lines =
  scriptPath === undefined
    ? []
    : readFileSync(scriptPath, 'utf8').split('\n').filter((l) => l.trim() !== '')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// stdout.write 的返回值不能忽略：管道满了要等 drain，否则帧会丢。
function write(chunk) {
  return new Promise((resolve) => {
    if (process.stdout.write(chunk)) resolve()
    else process.stdout.once('drain', resolve)
  })
}

// 孙进程：不 detach（跟 fake-claude 同进程组），引擎按组杀时它必须一起死。
// 先吐一帧把 pid 告诉测试。
if (spawnSleeper) {
  const { spawn } = await import('node:child_process')
  const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 100000)'], {
    stdio: 'ignore',
  })
  sleeper.unref()
  await write(JSON.stringify({ type: 'fake-claude.sleeper', pid: sleeper.pid }) + '\n')
}

for (const line of lines) {
  if (splitBytes) {
    // 切在第一个多字节字符的首字节后面 —— 保证跨 chunk 边界劈开一个字符
    const buf = Buffer.from(line + '\n', 'utf8')
    const hi = buf.findIndex((b) => b >= 0x80)
    const at = hi === -1 ? Math.floor(buf.length / 2) : hi + 1
    await write(buf.subarray(0, at))
    await sleep(1)
    await write(buf.subarray(at))
  } else if (split && line.length > 1) {
    const at = Math.floor(line.length / 2)
    await write(line.slice(0, at))
    await sleep(1)
    await write(line.slice(at) + '\n')
  } else {
    await write(line + '\n')
  }
  if (delay > 0) await sleep(delay)
}

// --hold：挂着不退，等信号（默认信号行为 = 死亡），测 stop()/退出钩子用
if (hold) {
  setInterval(() => {}, 100000)
} else {
  // 给 stdin 的 pipe 一点时间把最后的数据刷出去
  await sleep(10)
  process.exit(exitCode)
}
