# cc-web

给 Claude Code 做的本地 web UI。服务器起在 `127.0.0.1`，
引擎是 headless `claude` 子进程。**不改 CC 本体**（是分发的二进制，改不了）。

## 命令

```sh
pnpm test          # 单元测试，只跑假 claude，秒级
pnpm test:contract # 契约测试，跑真实 claude，需登录态
pnpm lint          # 约定检查
pnpm typecheck
```

## 目录

| 路径 | 装什么 |
| --- | --- |
| `src/engine` | 唯一跟 CC 打交道的地方。协议变了只改这里 |
| `src/sessions` | 读 `~/.claude/projects/**/*.jsonl` |
| `src/server` | 路由、鉴权、WS 广播 |
| `src/web` | 薄客户端，**不写测试** |
| `test/contract` | probe，跑真实 claude 录帧 |

## 红线

1. **单元测试不许碰真实 `claude`** —— 用 `test/fixtures/fake-claude.mjs`。
   要验真协议就写 probe 放 `test/contract/`。
2. **`src/web` 下不许有测试文件** —— 出现了说明逻辑漏进 UI 了，下沉到 server。
   `pnpm lint` 会拦。
3. **协议形状不许猜** —— 事实来源是
   `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` 加录到的帧。
4. **审批必须有超时** —— 不做超时，用户关掉浏览器就把引擎永久卡死。
   不要用「浏览器断开就自动 deny」代替，用户可能只是刷新页面。

## 深入

`docs/PLAN.md` 起步，`docs/TDD.md` 有逐里程碑测试清单，`docs/agents/` 是 skills 约定（issue tracker / triage 标签 / 领域文档）。
按需读，不要往本文件搬（预算 40 行，`pnpm lint` 会拦）。
