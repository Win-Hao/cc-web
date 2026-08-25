#!/usr/bin/env node
/**
 * 约定检查器 —— 每条在乎的规则都要有机器执行者，否则不算规则。
 * 依据见 docs/AGENT-DOCS.md。
 *
 *   1. src/web/ 下不许有测试文件（架构决策 D2：UI 是薄客户端）
 *   2. 根 AGENTS.md 不超过 40 行（常驻上下文预算）
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const AGENTS_MD_MAX_LINES = 40

const fail = []

// ── 规则 1：src/web 不写测试 ────────────────────────────────
// UI 里出现测试 = 有逻辑漏进 UI 了。把它推回 server，
// 否则以后换 UI 组件时测试会跟着一起废。
{
  const webDir = join(ROOT, 'src/web')
  const stack = existsSync(webDir) ? [webDir] : []
  while (stack.length > 0) {
    const dir = stack.pop()
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (/\.(spec|test)\.[cm]?[jt]sx?$/.test(e.name)) {
        fail.push(
          `${relative(ROOT, p)}: src/web 下不允许有测试文件。\n` +
            `  出现测试说明有逻辑漏进 UI 了 —— 把它下沉到 src/server 或 src/engine，\n` +
            `  在那里测。见 docs/ARCHITECTURE.md D2。`,
        )
      }
    }
  }
}

// ── 规则 2：AGENTS.md 的行数预算 ─────────────────────────────
// 实测研究：context 文件让推理 token 涨 14-22%，且 agent 会「太老实地」
// 遵守每一条。常驻的东西越少越好，超了就拆去 docs/ 按需读。
{
  const p = join(ROOT, 'AGENTS.md')
  if (existsSync(p)) {
    const n = readFileSync(p, 'utf8').split('\n').length
    if (n > AGENTS_MD_MAX_LINES) {
      fail.push(
        `AGENTS.md: ${n} 行，超出预算 ${AGENTS_MD_MAX_LINES} 行。\n` +
          `  不要往上堆 —— 把细节移到 docs/ 让 agent 按需读。\n` +
          `  见 docs/AGENT-DOCS.md。`,
      )
    }
  }
}

if (fail.length > 0) {
  console.error('约定检查未通过：\n')
  for (const f of fail) console.error(`  ✗ ${f}\n`)
  process.exit(1)
}
console.log('约定检查通过')
