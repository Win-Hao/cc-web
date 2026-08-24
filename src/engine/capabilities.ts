/**
 * M39：claude CLI 能力探测（同类实现的实战模式）。
 *
 * 新 flag 在老版本 CLI 上是 "unknown option" + exit 1 —— 直接杀死会话
 * （sugyan 类项目的典型死因之一）。启动后探测一次 `claude -p --help`，
 * 只对探测到的 flag 传参；探测本身失败（超时/二进制异常）回退到
 * README 基线（2.1.241）的假设，不阻断启动。
 */
import { execFile } from 'node:child_process'

export interface ClaudeCapabilities {
  /** --include-partial-messages：流式增量帧（没有 → 无打字机效果，功能不损） */
  partialMessages: boolean
  /** --allow-dangerously-skip-permissions：bypassPermissions 可切换 */
  allowDangerousSkip: boolean
  /** --session-id：服务器发 uuid 新建会话 */
  sessionId: boolean
}

/** README 基线（2.1.241）：探测失败时的假设 */
export const BASELINE_CAPABILITIES: ClaudeCapabilities = {
  partialMessages: true,
  allowDangerousSkip: true,
  sessionId: true,
}

export function parseHelpCapabilities(helpText: string): ClaudeCapabilities {
  return {
    partialMessages: helpText.includes('--include-partial-messages'),
    allowDangerousSkip: helpText.includes('--allow-dangerously-skip-permissions'),
    sessionId: helpText.includes('--session-id'),
  }
}

let probe: Promise<ClaudeCapabilities> | null = null

/** 进程内只探测一次；并发调用共享同一次。 */
export function probeClaudeCapabilities(bin: string): Promise<ClaudeCapabilities> {
  if (probe === null) {
    probe = new Promise((resolve) => {
      execFile(bin, ['-p', '--help'], { timeout: 10_000 }, (err, stdout, stderr) => {
        const text = `${String(stdout)}\n${String(stderr)}`
        if (err !== null && text.trim() === '') {
          resolve(BASELINE_CAPABILITIES) // 探测不到就按基线假设，别拦着能跑的用户
        } else {
          resolve(parseHelpCapabilities(text))
        }
      })
    })
  }
  return probe
}

/** 测试用：清掉缓存的探测结果。 */
export function resetCapabilityProbe(): void {
  probe = null
}
