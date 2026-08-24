/**
 * 测试桩：冒充 cc-web 服务器入口。hook spawn 它之后，
 * 它把收到的 argv 落盘到 CC_WEB_STUB_OUT，供测试断言。
 */
import { writeFileSync } from 'node:fs'

writeFileSync(
  process.env.CC_WEB_STUB_OUT,
  JSON.stringify({ argv: process.argv.slice(2) }),
)
