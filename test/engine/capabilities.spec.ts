/**
 * M39：CLI 能力探测 + flag 门控 —— 老版本 claude 没有的 flag 不传
 * （"unknown option" exit 1 是 sugyan 类项目的典型死因）。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BASELINE_CAPABILITIES, parseHelpCapabilities, probeClaudeCapabilities, resetCapabilityProbe,
} from '#/engine/capabilities.js'
import { buildEngineArgs } from '#/server/cli.js'

const MODERN_HELP = `
Usage: claude -p [options]
  --include-partial-messages   Include partial streaming events
  --allow-dangerously-skip-permissions  Enable bypassing all permission checks as an option
  --session-id <uuid>          Use a specific session ID
  --resume [value]             Resume a conversation
`
const OLD_HELP = `
Usage: claude -p [options]
  --resume [value]             Resume a conversation
  --output-format <format>     Output format
`

beforeEach(() => resetCapabilityProbe())

describe('parseHelpCapabilities', () => {
  it('新版 help：三个能力都在', () => {
    expect(parseHelpCapabilities(MODERN_HELP)).toEqual({
      partialMessages: true,
      allowDangerousSkip: true,
      sessionId: true,
    })
  })

  it('老版 help：都不在', () => {
    expect(parseHelpCapabilities(OLD_HELP)).toEqual({
      partialMessages: false,
      allowDangerousSkip: false,
      sessionId: false,
    })
  })
})

describe('buildEngineArgs 门控', () => {
  it('全能力：带全部 flag', () => {
    const args = buildEngineArgs(BASELINE_CAPABILITIES, { resume: 'abc' })
    expect(args).toContain('--include-partial-messages')
    expect(args).toContain('--allow-dangerously-skip-permissions')
    expect(args).toContain('--resume')
  })

  it('老版本：可选 flag 全部不传（会话能跑，只是功能退化）', () => {
    const caps = { partialMessages: false, allowDangerousSkip: false, sessionId: false }
    const args = buildEngineArgs(caps, { resume: 'abc' })
    expect(args).not.toContain('--include-partial-messages')
    expect(args).not.toContain('--allow-dangerously-skip-permissions')
    expect(args.slice(-2)).toEqual(['--resume', 'abc'])
  })

  it('老版本新建会话：明确报错（而不是让 CLI 用 unknown option 崩）', () => {
    const caps = { partialMessages: true, allowDangerousSkip: true, sessionId: false }
    expect(() => buildEngineArgs(caps, { newSessionId: 'u1' })).toThrow(/--session-id/)
  })
})

describe('probeClaudeCapabilities', () => {
  function fakeBin(helpText: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'cc-web-caps-'))
    const bin = join(dir, 'fake-claude-help')
    writeFileSync(bin, `#!/bin/sh\necho '${helpText.replace(/'/g, '')}'\n`)
    chmodSync(bin, 0o755)
    return bin
  }

  it('从真实 --help 输出解析（并发共享同一次探测）', async () => {
    const bin = fakeBin('--include-partial-messages and --session-id here')
    const [a, b] = await Promise.all([probeClaudeCapabilities(bin), probeClaudeCapabilities(bin)])
    expect(a).toEqual({ partialMessages: true, allowDangerousSkip: false, sessionId: true })
    expect(b).toBe(a instanceof Object ? a : b) // 共享缓存
  })

  it('二进制不存在：回退基线假设，不拦着能跑的用户', async () => {
    const caps = await probeClaudeCapabilities('/definitely/not/a/binary')
    expect(caps).toEqual(BASELINE_CAPABILITIES)
  })
})
