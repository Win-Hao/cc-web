import { defineConfig, mergeConfig } from 'vitest/config'
import base from './vitest.config'

// 契约测试单独一份 config：默认的 include 只认 *.spec.ts，
// probe 文件不会被 `pnpm test` 误捡到。
export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: ['test/contract/**/*.probe.ts'],
      // 跑真实 claude，慢
      testTimeout: 120_000,
    },
  }),
)
