/**
 * D8：真实 claude 的引擎工厂 —— CLI flag 组装 + 能力门控 + 三种起法。
 *
 * - 已有会话：--resume，cwd 设成会话原 cwd（D3，从 jsonl 行里读；
 *   读 jsonl 是 src/sessions 的事，这里只拿注入的 resolveCwd）
 * - 新建会话（opts.newSessionCwd）：--session-id 指定服务器发的 uuid，
 *   cwd 用调用方给的目录 —— CC 会在首条消息时落盘对应 jsonl
 * - 分叉（opts.forkFrom，M55）：--resume 旧会话 + --fork-session，
 *   cwd 沿用旧会话的；新 id 由 CC 发，从首帧读回（Engine.awaitSessionId）
 */
import { probeClaudeCapabilities } from './capabilities.js'
import type { ClaudeCapabilities } from './capabilities.js'
import { Engine } from './engine.js'
import type { ProtocolOptions } from './engine.js'
import type { EngineFactory } from './types.js'

/**
 * 按探测到的能力组装引擎参数（M39）：老版本 CLI 没有的 flag 不传，
 * 避免 "unknown option" exit 1 杀死会话。
 * - --include-partial-messages：没有则退化为无打字机效果
 * - --allow-dangerously-skip-permissions：把 bypass 变成可切换选项
 *   （2.1.241 实测；没有则 UI 切 bypass 会被引擎拒绝并回滚，功能不损）
 * - --replay-user-messages：user 帧回显带 uuid（D7）；没有则提示词占位不被替换
 * - --session-id：新建会话必需，没有就明确报错
 */
export function buildEngineArgs(
  caps: ClaudeCapabilities,
  opts: { resume?: string; newSessionId?: string; fork?: boolean },
): string[] {
  const args = ['-p', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json']
  if (caps.partialMessages) args.push('--include-partial-messages')
  if (caps.allowDangerousSkip) args.push('--allow-dangerously-skip-permissions')
  if (caps.replayUserMessages) args.push('--replay-user-messages')
  if (opts.newSessionId !== undefined) {
    if (!caps.sessionId) {
      throw new Error('claude CLI is too old for new sessions (missing --session-id); please upgrade')
    }
    args.push('--session-id', opts.newSessionId)
  } else if (opts.resume !== undefined) {
    args.push('--resume', opts.resume)
    if (opts.fork === true) args.push('--fork-session') // M55：分叉，新 id 由 CC 发
  }
  return args
}

export interface ClaudeEngineFactoryDeps extends ProtocolOptions {
  /** claude 二进制；默认走 PATH */
  bin?: string
  /** 已有会话的原 cwd（resume / fork 用）；拿不到 → null，用服务器当前目录 */
  resolveCwd: (sessionId: string) => Promise<string | null>
  /** 能力探测；默认 `claude -p --help` 进程内只探测一次 */
  probe?: (bin: string) => Promise<ClaudeCapabilities>
}

export function claudeEngineFactory(deps: ClaudeEngineFactoryDeps): EngineFactory {
  const bin = deps.bin ?? 'claude'
  const probe = deps.probe ?? probeClaudeCapabilities
  const protocol: ProtocolOptions = {
    ...(deps.controlTimeoutMs !== undefined ? { controlTimeoutMs: deps.controlTimeoutMs } : {}),
    ...(deps.newRequestId !== undefined ? { newRequestId: deps.newRequestId } : {}),
  }
  const withCwd = (cwd: string | null) => (cwd !== null ? { cwd } : {})
  return async (sessionId, opts) => {
    const caps = await probe(bin)
    if (opts?.forkFrom !== undefined) {
      const cwd = await deps.resolveCwd(opts.forkFrom)
      return new Engine({ bin, args: buildEngineArgs(caps, { resume: opts.forkFrom, fork: true }), ...withCwd(cwd), ...protocol })
    }
    if (opts?.newSessionCwd !== undefined) {
      return new Engine({ bin, args: buildEngineArgs(caps, { newSessionId: sessionId }), cwd: opts.newSessionCwd, ...protocol })
    }
    const cwd = await deps.resolveCwd(sessionId)
    return new Engine({ bin, args: buildEngineArgs(caps, { resume: sessionId }), ...withCwd(cwd), ...protocol })
  }
}
