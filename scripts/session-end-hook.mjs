#!/usr/bin/env node
/**
 * CC SessionEnd hook：有标记文件才启动 cc-web 服务器。
 *
 * 链路（ARCHITECTURE「交接怎么做」）：
 *   /cc-web skill  → 写标记 ~/.cc-web/handoff.json，提示用户退出
 *   SessionEnd hook（本脚本）→ 读标记，启动服务器（--resume <id>），删掉标记
 *
 * session id 来源（M16 加固）：优先 hook stdin 的 JSON（CC 会喂
 * {session_id, ...}，skill 不用自己知道会话 id），退回标记文件里的
 * session_id。两处都拿不到 → 静默退出，绝不让 hook 报错打扰 CC 退出。
 *
 * 读完标记**就删** —— 下次 CC 正常退出（没有 /cc-web 意图）不会误触发。
 * 没有标记时静默退出，这是绝大多数调用。
 *
 * hook 是 CC spawn 的子进程，CC 主进程该退还是退（拿不到「同一 PID
 * 从 TUI 变服务器」的效果），所以服务器必须自己把进程管理做扎实（D3）。
 */
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const marker = process.env.CC_WEB_MARKER ?? join(homedir(), '.cc-web', 'handoff.json')
if (!existsSync(marker)) process.exit(0)

/** 任何一步坏了都回 null，不 throw —— hook 崩溃比什么都不做更糟 */
function sessionIdFrom(read) {
  try {
    const parsed = JSON.parse(read())
    const id = parsed?.session_id
    return typeof id === 'string' && id !== '' ? id : null
  } catch {
    return null
  }
}

// stdin 是 CC 喂的 hook 输入 JSON；tty（手动跑）不读，避免阻塞
const fromStdin = process.stdin.isTTY ? null : sessionIdFrom(() => readFileSync(0, 'utf8'))
const fromMarker = sessionIdFrom(() => readFileSync(marker, 'utf8'))

try {
  unlinkSync(marker) // 读完就删（就算 id 拿不到也删，绝不留着反复触发）
} catch {
  // 删不掉（权限/竞态）也不拦着启动
}

const sessionId = fromStdin ?? fromMarker
if (sessionId === null) process.exit(0)

const entry =
  process.env.CC_WEB_SERVER_ENTRY ??
  fileURLToPath(new URL('../src/server/main.ts', import.meta.url))

// .ts 入口需要 tsx；TSX_TSCONFIG_PATH 钉到本仓库，不吃用户 shell 里的残留
const isTs = entry.endsWith('.ts')
const args = [...(isTs ? ['--import', 'tsx'] : []), entry, '--resume', sessionId]
const child = spawn(process.execPath, args, {
  detached: true, // 服务器要活得比 hook 久
  stdio: 'ignore',
  env: {
    ...process.env,
    TSX_TSCONFIG_PATH: fileURLToPath(new URL('../tsconfig.json', import.meta.url)),
  },
})
child.unref()
