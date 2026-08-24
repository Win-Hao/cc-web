# cc-web

给 Claude Code 做一个**本地** web UI —— 起一个只绑 `127.0.0.1` 的服务器，
在浏览器里接着聊当前会话。实现走「方案 C」：
把 headless CC 子进程当引擎，服务器只做桥接。

跟 CC 自带的 `/remote-control` 的区别：那个是**遥控**（会话留在本机跑，
界面在 Anthropic 云端，必须联网）；这个是**交接**（界面和数据全在本机，
断网可用，代价是端口和 token 要自己管）。

## 现在处于什么阶段

**只有方案，还没有实现。** 先读 `docs/PLAN.md`。

## 文档

| 文件 | 内容 |
| --- | --- |
| [docs/PLAN.md](docs/PLAN.md) | 总方案：目标、非目标、里程碑排期 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 分层、数据流、六条关键决策 + 为什么 |
| [docs/PROTOCOL.md](docs/PROTOCOL.md) | CC 对外面的接口：**哪些已验证、哪些要探测** |
| [docs/API.md](docs/API.md) | HTTP / WebSocket 接口设计 |
| [docs/TDD.md](docs/TDD.md) | TDD 工作流 + 逐里程碑的测试清单 |
| [docs/RISKS.md](docs/RISKS.md) | 已知的坑，含同类项目踩过的那几个 |

## 快速开始

```sh
pnpm install
pnpm build:web     # 构建 React 前端（dist/web，服务器自动托管；没构建则回退占位页）
pnpm test          # 单元测试，只跑假二进制，秒级
pnpm test:contract # 契约测试，跑真实 claude，需要登录态
```

前端开发热更流：`pnpm dev`（后端）+ `pnpm dev:web`（vite，代理 /api 到 58630），
浏览器开 vite 地址并带上 `#token=<~/.cc-web/server.token 内容>`。
前端：React + Vite + Tailwind v4 + shadcn/ui（Radix 原语，组件 vendor 在
web/src/components/ui/）；design token 见 web/src/styles/globals.css（shadcn
语义变量，暗色跟随系统，配色后续会换成自己的视觉体系）。

## 交接：TUI ⇄ 浏览器

在 CC 里输入 `/cc-web`（skill 写意图标记）→ 退出 CC → SessionEnd hook
自动起服务器 `--resume` 本会话并打开浏览器。安装两步：

1. **hook**：`~/.claude/settings.json` 加上

   ```json
   {
     "hooks": {
       "SessionEnd": [
         { "hooks": [{ "type": "command", "command": "node <本仓库绝对路径>/scripts/session-end-hook.mjs" }] }
       ]
     }
   }
   ```

2. **skill**（可选，本仓库内用 CC 自带；全局用要拷一份）：
   `cp -r .claude/skills/cc-web ~/.claude/skills/`

没有标记文件时 hook 静默退出（绝大多数正常退出走这条路），标记读完即删，
不会反复触发；会话 id 优先取 hook stdin，标记损坏也不影响 CC 退出。

## 环境

- Node `>=24.15.0`，pnpm `10.33.0`
- 本机装了可用的 `claude`（开发时基线：`2.1.241`）
