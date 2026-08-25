/**
 * 测试用假服务器 —— M1「服务器进程退出时子进程一起死」的被测载体。
 *
 * 它只做一件事：起一个引擎（挂 --hold 的假 claude），把引擎 pid 打到
 * stdout，然后挂住（或用 --exit-normally 正常退出）。它自己不挂任何
 * 信号处理 —— 退出清理由 Engine 注册的钩子负责，那正是被测对象。
 *
 * 用法：node --import tsx fake-server.mts <fake-claude-path> [--exit-normally]
 */
import { Engine } from '../../src/engine/index.js'

const fake = process.argv[2]!
const engine = new Engine({ bin: process.execPath, args: [fake, '--hold'] })
engine.on('error', () => {}) // 测试里只关心进程死活
await engine.start()
console.log(`ENGINE_PID=${engine.pid}`)

if (process.argv.includes('--exit-normally')) {
  // 给测试留出读到 pid 的时间，然后正常退出
  setTimeout(() => process.exit(0), 500)
} else {
  setInterval(() => {}, 100000)
}
