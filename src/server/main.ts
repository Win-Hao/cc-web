/**
 * 入口（pnpm dev / 生产）：cc-web [--resume <id>] [--no-open]。
 * 只做接线，逻辑全在 cli.ts / bootstrap.ts。
 */
import { exec } from 'node:child_process'
import { run } from './cli.js'
import { startServer } from './bootstrap.js'

const boot = await run(process.argv.slice(2), {
  startServer,
  open: (url) => {
    exec(`open ${JSON.stringify(url)}`)
  },
})

// 打印出来备用：浏览器没自动开（或 SSH 场景）时手动复制
console.log(boot.url)
