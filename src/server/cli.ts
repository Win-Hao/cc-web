/**
 * M10：cc-web CLI —— cc-web --resume <id> [--no-open] [--host H] [--port N]。
 *
 * 独立 CLI 路线（ARCHITECTURE）：服务器不是 daemon，用户自己开一个
 * 终端跑；SessionEnd hook 交接是增强（scripts/session-end-hook.mjs）。
 * main.ts 只做一件事：用真实实现调 run()。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { claudeEngineFactory } from '#/engine/index.js'
import type { EngineFactory } from '#/engine/index.js'
import { findSessionFile, readSessionCwd } from '#/sessions/find.js'
import type { BootstrapDeps, BootResult } from './bootstrap.js'

export interface CliDeps {
  startServer: (deps: BootstrapDeps) => Promise<BootResult>
  /** 打开浏览器（生产是 macOS `open`，测试是 spy） */
  open: (url: string) => void
  projectsRoot?: string
  tokenPath?: string
  factory?: EngineFactory
}

export interface CliResult {
  url: string
  close: () => Promise<void>
}

/** session id 放 query（不敏感），token 留 fragment（不进 access log）。 */
export function sessionUrl(base: string, sessionId?: string): string {
  if (sessionId === undefined) return base
  const hash = base.indexOf('#')
  if (hash === -1) return `${base}?session=${sessionId}`
  return `${base.slice(0, hash)}?session=${sessionId}${base.slice(hash)}`
}

interface ParsedArgs {
  resume?: string
  noOpen: boolean
  host?: string
  port?: number
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { noOpen: false }
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i + 1]
    switch (argv[i]) {
      case '--resume':
        if (value !== undefined) out.resume = value
        i++
        break
      case '--no-open':
        out.noOpen = true
        break
      case '--host':
        if (value !== undefined) out.host = value
        i++
        break
      case '--port': {
        const n = Number(value)
        if (Number.isFinite(n)) out.port = n
        i++
        break
      }
    }
  }
  return out
}

export async function run(argv: string[], deps: CliDeps): Promise<CliResult> {
  const args = parseArgs(argv)
  const projectsRoot = deps.projectsRoot ?? join(homedir(), '.claude', 'projects')
  const tokenPath = deps.tokenPath ?? join(homedir(), '.cc-web', 'server.token')
  // 真实 claude（D8）：协议和 flag 组装在 src/engine，这里只接会话 cwd 的来源
  const factory =
    deps.factory ??
    claudeEngineFactory({
      resolveCwd: async (sessionId) => {
        const file = await findSessionFile(projectsRoot, sessionId)
        return file === null ? null : readSessionCwd(file)
      },
    })

  const boot = await deps.startServer({
    projectsRoot,
    tokenPath,
    factory,
    ...(args.host !== undefined ? { host: args.host } : {}),
    ...(args.port !== undefined ? { port: args.port } : {}),
  })
  const url = sessionUrl(boot.url, args.resume)
  if (!args.noOpen) deps.open(url)
  return { url, close: boot.close }
}
