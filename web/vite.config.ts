import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// root 显式指到本目录：`vite --config web/vite.config.ts` 从仓库根跑，
// 不设的话 root 会落在 cwd。产物进 <repo>/dist/web，由 cc-web 服务器托管。
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
  server: {
    // 开发流：先 `pnpm dev`（后端 58630），再 `pnpm dev:web`，
    // 浏览器开 vite 地址 + #token=<~/.cc-web/server.token 的内容>
    proxy: {
      '/api': { target: 'http://127.0.0.1:58630', ws: true },
    },
  },
})
