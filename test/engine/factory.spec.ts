/**
 * D8：真实 claude 的引擎工厂 —— 三种起法各自的 flag 与 cwd。
 * 不起进程：只看工厂交出的 Engine.spec（bin / args / cwd）。
 */
import { describe, it, expect } from 'vitest'
import { BASELINE_CAPABILITIES } from '#/engine/capabilities.js'
import { claudeEngineFactory, Engine } from '#/engine/index.js'

const probe = async () => BASELINE_CAPABILITIES
const resolveCwd = async (id: string) => (id === 'old' ? '/proj/old' : null)

async function make(sessionId: string, opts?: Parameters<ReturnType<typeof claudeEngineFactory>>[1]) {
  const factory = claudeEngineFactory({ bin: '/fake/claude', probe, resolveCwd })
  const engine = (await factory(sessionId, opts)) as Engine
  expect(engine).toBeInstanceOf(Engine)
  return engine.spec!
}

describe('claudeEngineFactory', () => {
  it('已有会话：--resume <id>，cwd 取会话原 cwd（D3）', async () => {
    const spec = await make('old')
    expect(spec.bin).toBe('/fake/claude')
    expect(spec.args.slice(-2)).toEqual(['--resume', 'old'])
    expect(spec.args).not.toContain('--fork-session')
    expect(spec.cwd).toBe('/proj/old')
  })

  it('已有会话但找不到 jsonl → 不设 cwd（用服务器当前目录）', async () => {
    const spec = await make('unknown')
    expect(spec.args.slice(-2)).toEqual(['--resume', 'unknown'])
    expect(spec.cwd).toBeUndefined()
  })

  it('新建会话：--session-id <服务器发的 uuid>，cwd 用给定目录，不 --resume', async () => {
    const spec = await make('new-1', { newSessionCwd: '/work' })
    expect(spec.args.slice(-2)).toEqual(['--session-id', 'new-1'])
    expect(spec.args).not.toContain('--resume')
    expect(spec.cwd).toBe('/work')
  })

  it('分叉（M55）：--resume <旧 id> --fork-session，cwd 沿用旧会话', async () => {
    const spec = await make('old', { forkFrom: 'old' })
    expect(spec.args.slice(-3)).toEqual(['--resume', 'old', '--fork-session'])
    expect(spec.cwd).toBe('/proj/old')
  })

  it('默认 bin 是 PATH 里的 claude；探测到的能力决定可选 flag', async () => {
    const factory = claudeEngineFactory({
      probe: async () => ({ ...BASELINE_CAPABILITIES, partialMessages: false }),
      resolveCwd,
    })
    const spec = ((await factory('old')) as Engine).spec!
    expect(spec.bin).toBe('claude')
    expect(spec.args).not.toContain('--include-partial-messages')
    expect(spec.args).toContain('--replay-user-messages')
  })
})
