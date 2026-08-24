import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: { '#': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    // 契约测试要真实 claude + 登录态，默认不跑；用 pnpm test:contract 单独跑。
    include: ['test/**/*.spec.ts'],
    coverage: {
      // 不设全局门槛：src/web 按设计就不测（见 docs/ARCHITECTURE.md D2），
      // 全局百分比没有意义。要守的是 engine 和 sessions 的分支覆盖。
      include: ['src/engine/**', 'src/sessions/**'],
    },
  },
})
